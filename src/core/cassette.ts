import { readFile } from 'node:fs/promises';

import { ConfigError } from './errors.js';
import { buildOutcome, sseExtraction, type HttpOutcome } from './http/client.js';
import { assembleSse, extractResponse, type ResponseSpec } from './http/extract.js';
import type { BuiltRequest } from './http/request.js';
import { parseSseChunk } from './http/sse.js';
import type { StreamMode } from './types.js';
import { canonicalJson } from './utils/hash.js';
import { redactHeaders, type Redactor } from './utils/redact.js';

export const CASSETTE_VERSION = 1;

export interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
}

export interface RecordedExchange {
  request: RecordedRequest;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyText: string;
  latencyMs: number;
  ttftMs?: number;
  error?: string;
  errorKind?: HttpOutcome['errorKind'];
  attempts?: number;
}

export interface Cassette {
  version: number;
  suiteName: string;
  recordedAt: string;
  /** Run id of the recording run, reused for `{{conversation.id}}` on replay. */
  runId: string;
  exchanges: Record<string, RecordedExchange>;
}

export function createCassette(suiteName: string, now: Date = new Date()): Cassette {
  return { version: CASSETTE_VERSION, suiteName, recordedAt: now.toISOString(), runId: '', exchanges: {} };
}

export function exchangeKey(caseId: string, attempt: number, turn: number): string {
  return `${caseId}#${attempt + 1}#${turn + 1}`;
}

export function recordExchange(request: BuiltRequest, outcome: HttpOutcome): RecordedExchange {
  return {
    request: recordedRequest(request),
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    ...(outcome.statusText !== undefined ? { statusText: outcome.statusText } : {}),
    ...(outcome.headers ? { headers: outcome.headers } : {}),
    bodyText: outcome.bodyText,
    latencyMs: outcome.latencyMs,
    ...(outcome.ttftMs !== undefined ? { ttftMs: outcome.ttftMs } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
    ...(outcome.attempts !== undefined ? { attempts: outcome.attempts } : {}),
  };
}

export function recordedRequest(request: BuiltRequest): RecordedRequest {
  return {
    method: request.method,
    url: request.url,
    ...(request.body !== undefined ? { body: request.body } : {}),
  };
}

export function sameRequest(a: RecordedRequest, b: RecordedRequest): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Rebuilds the outcome from the recorded body, so changes to `textPath` or `chunkPath` apply on replay. */
export function replayExchange(exchange: RecordedExchange, response: ResponseSpec, stream: StreamMode): HttpOutcome {
  if (exchange.status === undefined) {
    return {
      ok: false,
      bodyText: '',
      text: '',
      latencyMs: exchange.latencyMs,
      ...(exchange.error ? { error: exchange.error } : {}),
      ...(exchange.errorKind ? { errorKind: exchange.errorKind } : {}),
      ...(exchange.attempts !== undefined ? { attempts: exchange.attempts } : {}),
      warnings: [],
    };
  }

  const extraction =
    stream === 'sse'
      ? sseExtraction(assembleSse(parseSseChunk(`${exchange.bodyText}\n\n`).events, response))
      : extractResponse(exchange.bodyText, response);

  const outcome = buildOutcome({
    status: exchange.status,
    ...(exchange.statusText !== undefined ? { statusText: exchange.statusText } : {}),
    ...(exchange.headers ? { headers: exchange.headers } : {}),
    bodyText: exchange.bodyText,
    extraction,
    latencyMs: exchange.latencyMs,
    ...(exchange.ttftMs !== undefined ? { ttftMs: exchange.ttftMs } : {}),
    expectedStatus: response.status,
  });
  return { ...outcome, ...(exchange.attempts !== undefined ? { attempts: exchange.attempts } : {}) };
}

export function redactCassette(cassette: Cassette, redactor: Redactor): void {
  for (const [key, exchange] of Object.entries(cassette.exchanges)) {
    cassette.exchanges[key] = {
      ...redactor.redactDeep(exchange),
      ...(exchange.headers ? { headers: redactHeaders(exchange.headers, redactor) } : {}),
    };
  }
}

export function serializeCassette(cassette: Cassette): string {
  return `${JSON.stringify(cassette, null, 2)}\n`;
}

export function parseCassette(content: string, source = 'recording'): Cassette {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new ConfigError(`Cannot parse ${source} as JSON`, [{ path: '', message: (err as Error).message }]);
  }
  const record = parsed as Partial<Cassette> | null;
  if (!record || typeof record !== 'object' || typeof record.exchanges !== 'object' || record.exchanges === null) {
    throw new ConfigError(`Invalid ${source}`, [{ path: '', message: 'expected an evalcheck recording with "exchanges"' }]);
  }
  if (record.version !== CASSETTE_VERSION) {
    throw new ConfigError(`Unsupported ${source}`, [
      { path: 'version', message: `expected version ${CASSETTE_VERSION}, received ${String(record.version)}` },
    ]);
  }
  return {
    version: record.version,
    suiteName: String(record.suiteName ?? ''),
    recordedAt: String(record.recordedAt ?? ''),
    runId: String(record.runId ?? ''),
    exchanges: record.exchanges,
  };
}

export async function loadCassette(file: string): Promise<Cassette> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read recording "${file}"`, [{ path: '', message: (err as Error).message }]);
  }
  return parseCassette(content, `recording "${file}"`);
}
