// Endpoint problems never throw: they are returned as an outcome so the runner can tell
// an unreachable endpoint from a failed case.

import { request as undiciRequest, type Dispatcher } from 'undici';

import type { Logger } from '../types.js';
import type { RetryConfig, StreamMode } from '../types.js';
import { extractResponse, assembleSse, type ResponseSpec } from './extract.js';
import { isDoneEvent, parseSseChunk, type SseEvent } from './sse.js';
import type { BuiltRequest } from './request.js';

export interface HttpCallOptions {
  request: BuiltRequest;
  timeoutMs: number;
  retries: RetryConfig;
  stream: StreamMode;
  response: ResponseSpec;
  logger?: Logger;
  dispatcher?: Dispatcher;
  /** Injectable sleep, used by tests to avoid real delays. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface HttpOutcome {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyText: string;
  text: string;
  json?: unknown;
  bodyJson?: unknown;
  latencyMs: number;
  ttftMs?: number;
  error?: string;
  errorKind?: 'timeout' | 'network' | 'http' | 'extract';
  attempts?: number;
  warnings: string[];
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export async function executeRequest(options: HttpCallOptions): Promise<HttpOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger;
  const maxAttempts = Math.max(0, options.retries.max) + 1;

  let last: HttpOutcome | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const outcome = await attemptRequest(options, now);
    last = { ...outcome, attempts: attempt + 1 };

    const retryable = isRetryable(outcome, options.retries);
    if (!retryable || attempt === maxAttempts - 1) {
      return last;
    }

    const backoff = options.retries.backoffMs * 2 ** attempt;
    logger?.debug(
      `retrying request (attempt ${attempt + 2}/${maxAttempts}) in ${backoff}ms: ${outcome.error ?? `status ${outcome.status}`}`,
    );
    if (backoff > 0) await sleep(backoff);
  }
  return last!;
}

function isRetryable(outcome: HttpOutcome, retries: RetryConfig): boolean {
  const on = retries.on;
  if (on.length === 0) return false;
  if (outcome.errorKind === 'timeout') return on.includes('timeout');
  if (outcome.errorKind === 'network') return on.includes('network');
  if (typeof outcome.status === 'number') {
    if (on.includes(outcome.status)) return true;
    if (outcome.status >= 500 && on.includes('5xx' as never)) return true;
    if (outcome.status >= 400 && outcome.status < 500 && on.includes('4xx' as never)) return true;
  }
  return false;
}

async function attemptRequest(options: HttpCallOptions, now: () => number): Promise<HttpOutcome> {
  const { request: req, timeoutMs, stream, response, dispatcher } = options;
  const start = now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  try {
    const body =
      req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const res = await undiciRequest(req.url, {
      method: req.method,
      headers: req.headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.headers)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    if (stream === 'sse') {
      return await readSse(res, response, start, now, headers);
    }

    const bodyText = await res.body.text();
    const latencyMs = now() - start;
    const extraction = extractResponse(bodyText, response);
    const expected = response.status;
    const statusOk = expected !== undefined ? res.statusCode === expected : isSuccess(res.statusCode);

    return {
      ok: statusOk,
      status: res.statusCode,
      statusText: res.statusText,
      headers,
      bodyText,
      text: extraction.text,
      ...(extraction.json !== undefined ? { json: extraction.json } : {}),
      ...(extraction.bodyJson !== undefined ? { bodyJson: extraction.bodyJson } : {}),
      latencyMs,
      ...(statusOk
        ? {}
        : {
            error:
              expected !== undefined
                ? `expected HTTP ${expected} but received ${res.statusCode}`
                : `received HTTP ${res.statusCode}`,
            errorKind: 'http' as const,
          }),
      warnings: extraction.warnings,
    };
  } catch (err) {
    const latencyMs = now() - start;
    if (timedOut) {
      return {
        ok: false,
        bodyText: '',
        text: '',
        latencyMs,
        error: `request timed out after ${timeoutMs}ms`,
        errorKind: 'timeout',
        warnings: [],
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      bodyText: '',
      text: '',
      latencyMs,
      error: describeNetworkError(err, message),
      errorKind: 'network',
      warnings: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readSse(
  res: { body: AsyncIterable<Buffer | Uint8Array>; statusCode: number; statusText: string },
  response: ResponseSpec,
  start: number,
  now: () => number,
  headers: Record<string, string>,
): Promise<HttpOutcome> {
  const events: SseEvent[] = [];
  let buffer = '';
  let firstTokenAt: number | undefined;
  let bodyText = '';

  for await (const chunk of res.body) {
    const piece = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    bodyText += piece;
    buffer += piece;
    const { events: parsed, rest } = parseSseChunk(buffer);
    buffer = rest;
    if (parsed.length > 0) {
      events.push(...parsed);
      if (firstTokenAt === undefined) {
        const assembly = assembleSse(parsed, response);
        if (assembly.chunkValues.some((v) => v.length > 0)) {
          firstTokenAt = now();
        }
      }
    }
    if (events.some((e) => isDoneEvent(e))) break;
  }

  if (buffer.trim() !== '' && !buffer.trimStart().startsWith('data:')) {
    // trailing partial frame - ignore
  } else if (buffer.trim() !== '') {
    const { events: parsed } = parseSseChunk(`${buffer}\n\n`);
    if (parsed.length > 0) {
      events.push(...parsed);
      if (firstTokenAt === undefined) {
        const assembly = assembleSse(parsed, response);
        if (assembly.chunkValues.some((v) => v.length > 0)) firstTokenAt = now();
      }
    }
  }

  const assembly = assembleSse(events, response);
  const latencyMs = now() - start;
  const expected = response.status;
  const statusOk = expected !== undefined ? res.statusCode === expected : isSuccess(res.statusCode);

  let json: unknown;
  if (assembly.text) {
    const trimmed = assembly.text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        json = JSON.parse(trimmed);
      } catch {
        json = undefined;
      }
    }
  }

  return {
    ok: statusOk,
    status: res.statusCode,
    statusText: res.statusText,
    headers,
    bodyText,
    text: assembly.text,
    ...(json !== undefined ? { json } : {}),
    ...(assembly.bodyJson !== undefined ? { bodyJson: assembly.bodyJson } : {}),
    latencyMs,
    ...(firstTokenAt !== undefined ? { ttftMs: firstTokenAt - start } : {}),
    ...(statusOk
      ? {}
      : {
          error:
            expected !== undefined
              ? `expected HTTP ${expected} but received ${res.statusCode}`
              : `received HTTP ${res.statusCode}`,
          errorKind: 'http' as const,
        }),
    warnings: assembly.warnings,
  };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function describeNetworkError(err: unknown, message: string): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  if (code) return `${message} (${code})`;
  return message;
}
