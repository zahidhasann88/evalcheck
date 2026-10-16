import { jsonPathQuery } from '../utils/jsonpath.js';
import type { SseEvent } from './sse.js';

export interface ResponseSpec {
  textPath?: string;
  chunkPath?: string;
  status?: number;
}

export interface ExtractionResult {
  /** The text that graders inspect. */
  text: string;
  /** Parsed JSON of the extracted text (when it is valid JSON). */
  json?: unknown;
  /** Parsed JSON of the whole response body. */
  bodyJson?: unknown;
  warnings: string[];
}

export function extractResponse(bodyText: string, spec: ResponseSpec): ExtractionResult {
  const warnings: string[] = [];
  const bodyJson = tryParseJson(bodyText);

  if (!spec.textPath) {
    return {
      text: bodyText,
      ...(bodyJson !== undefined ? { json: bodyJson, bodyJson } : {}),
      warnings,
    };
  }

  if (bodyJson === undefined) {
    warnings.push(
      `response is not valid JSON, cannot apply textPath "${spec.textPath}"; using the raw body as text`,
    );
    return { text: bodyText, warnings };
  }

  let matches: unknown[];
  try {
    matches = jsonPathQuery(bodyJson, spec.textPath);
  } catch (err) {
    warnings.push(`invalid textPath "${spec.textPath}": ${(err as Error).message}`);
    return { text: bodyText, bodyJson, warnings };
  }

  if (matches.length === 0) {
    warnings.push(`textPath "${spec.textPath}" did not match anything in the response`);
    return { text: '', bodyJson, warnings };
  }

  const value = matches[0];
  const text = stringifyValue(value);
  return {
    text,
    json: value,
    bodyJson,
    warnings,
  };
}

export interface SseAssembly {
  text: string;
  bodyJson?: unknown;
  /** Per-event extracted values (used for TTFT measurement). */
  chunkValues: string[];
  warnings: string[];
}

/** `chunkPath` values are concatenated; with only `textPath`, a final event that repeats the text wins. */
export function assembleSse(events: SseEvent[], spec: ResponseSpec): SseAssembly {
  const warnings: string[] = [];
  const chunkValues: string[] = [];
  const payloads: Array<{ parsed: unknown; raw: string; value: string }> = [];

  for (const event of events) {
    if (event.data.trim() === '[DONE]') continue;
    const parsed = tryParseJson(event.data);
    const value = extractEventValue(parsed, event.data, spec);
    payloads.push({ parsed, raw: event.data, value });
    chunkValues.push(value);
  }

  const nonEmpty = chunkValues.filter((v) => v.length > 0);

  if (spec.chunkPath) {
    return {
      text: nonEmpty.join(''),
      ...(payloads.length > 0 && payloads[payloads.length - 1]!.parsed !== undefined
        ? { bodyJson: payloads[payloads.length - 1]!.parsed }
        : {}),
      chunkValues,
      warnings,
    };
  }

  if (spec.textPath) {
    if (nonEmpty.length === 1) {
      const last = payloads[payloads.length - 1]!;
      return {
        text: last.value,
        ...(last.parsed !== undefined ? { bodyJson: last.parsed } : {}),
        chunkValues,
        warnings,
      };
    }
    if (nonEmpty.length > 1) {
      // If the final event repeats the accumulated text, prefer the final one.
      const last = payloads[payloads.length - 1]!;
      const previous = chunkValues.slice(0, -1).join('');
      if (last.value.length > 0 && previous.length > 0 && last.value.startsWith(previous)) {
        return {
          text: last.value,
          ...(last.parsed !== undefined ? { bodyJson: last.parsed } : {}),
          chunkValues,
          warnings,
        };
      }
      return {
        text: nonEmpty.join(''),
        ...(last.parsed !== undefined ? { bodyJson: last.parsed } : {}),
        chunkValues,
        warnings,
      };
    }
    warnings.push(`textPath "${spec.textPath}" did not match any SSE event; falling back to raw payloads`);
  }

  return {
    text: payloads.map((p) => p.raw).join(''),
    ...(payloads.length > 0 && payloads[payloads.length - 1]!.parsed !== undefined
      ? { bodyJson: payloads[payloads.length - 1]!.parsed }
      : {}),
    chunkValues,
    warnings,
  };
}

function extractEventValue(parsed: unknown, raw: string, spec: ResponseSpec): string {
  const path = spec.chunkPath ?? spec.textPath;
  if (!path) return raw;
  if (parsed === undefined) return '';
  let matches: unknown[];
  try {
    matches = jsonPathQuery(parsed, path);
  } catch {
    return '';
  }
  return matches.map(stringifyValue).join('');
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
