import type { StreamMode, TokenUsage } from '../types.js';
import { jsonPathQuery } from '../utils/jsonpath.js';
import { round } from '../utils/stats.js';
import { parseSseChunk } from './sse.js';

export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Reads token usage from OpenAI, Anthropic and Gemini responses. For streams, every event is
 * inspected and the largest value of each field wins, because providers report usage in
 * different events.
 */
export function extractUsage(
  bodyText: string,
  bodyJson: unknown,
  stream: StreamMode,
  usagePath?: string,
): TokenUsage | undefined {
  const documents = stream === 'sse' ? sseDocuments(bodyText) : bodyJson === undefined ? [] : [bodyJson];
  let usage: TokenUsage | undefined;
  for (const document of documents) {
    const found = usagePath ? usageAtPath(document, usagePath) : findUsage(document);
    if (found) usage = mergeMax(usage, found);
  }
  if (usage && usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return usage;
}

export function withCost(usage: TokenUsage | undefined, pricing: Pricing | undefined): TokenUsage | undefined {
  if (!usage || !pricing) return usage;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return usage;
  const cost =
    ((usage.inputTokens ?? 0) * pricing.inputPerMillion + (usage.outputTokens ?? 0) * pricing.outputPerMillion) / 1_000_000;
  return { ...usage, cost: round(cost, 8) };
}

export function sumUsage(usages: Array<TokenUsage | undefined>): TokenUsage | undefined {
  const present = usages.filter((u): u is TokenUsage => u !== undefined);
  if (present.length === 0) return undefined;
  const total: TokenUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cost'] as const) {
    const values = present.map((u) => u[key]).filter((v): v is number => v !== undefined);
    if (values.length > 0) total[key] = round(values.reduce((sum, v) => sum + v, 0), 8);
  }
  return total;
}

function sseDocuments(bodyText: string): unknown[] {
  const documents: unknown[] = [];
  for (const event of parseSseChunk(`${bodyText}\n\n`).events) {
    try {
      documents.push(JSON.parse(event.data));
    } catch {
      continue;
    }
  }
  return documents;
}

function usageAtPath(document: unknown, path: string): TokenUsage | undefined {
  try {
    const [match] = jsonPathQuery(document, path);
    return isObject(match) ? readUsage(match) : undefined;
  } catch {
    return undefined;
  }
}

function findUsage(document: unknown): TokenUsage | undefined {
  if (!isObject(document)) return undefined;
  const candidates = [
    document.usage,
    document.usageMetadata,
    isObject(document.message) ? document.message.usage : undefined,
    isObject(document.response) ? document.response.usage : undefined,
  ];
  for (const candidate of candidates) {
    if (isObject(candidate)) {
      const usage = readUsage(candidate);
      if (usage) return usage;
    }
  }
  return undefined;
}

function readUsage(source: Record<string, unknown>): TokenUsage | undefined {
  const inputTokens = firstNumber(source, ['prompt_tokens', 'input_tokens', 'promptTokenCount', 'inputTokens']);
  const outputTokens = firstNumber(source, ['completion_tokens', 'output_tokens', 'candidatesTokenCount', 'outputTokens']);
  const totalTokens = firstNumber(source, ['total_tokens', 'totalTokenCount', 'totalTokens']);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function mergeMax(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return { ...b };
  const out: TokenUsage = { ...a };
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (b[key] !== undefined) out[key] = Math.max(out[key] ?? 0, b[key]);
  }
  return out;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
