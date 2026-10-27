import { canonicalJson } from '../utils/hash.js';
import { jsonPathQuery } from '../utils/jsonpath.js';
import type { Grader, ToolCallCheck } from '../types.js';
import { fail, pass } from './helpers.js';

export interface ToolCall {
  name: string;
  args: unknown;
}

export const toolCallGrader: Grader = (ctx) => {
  const check = ctx.check as ToolCallCheck;
  const document = isObject(ctx.bodyJson) ? ctx.bodyJson : ctx.json;
  if (document === undefined) {
    return fail(ctx, 'response is not valid JSON, cannot read tool calls', { score: 0, error: 'invalid-json' });
  }

  let calls: ToolCall[];
  try {
    calls = check.path ? callsAtPath(document, check.path) : findToolCalls(document);
  } catch (err) {
    return fail(ctx, `invalid JSONPath "${check.path}": ${(err as Error).message}`, { score: 0 });
  }
  const details = { calls: calls.map((c) => ({ name: c.name, args: c.args })) };
  const called = describeCalls(calls);

  if (check.called === false) {
    const forbidden = check.name ? calls.filter((c) => c.name === check.name) : calls;
    if (forbidden.length > 0) {
      const what = check.name ? `"${check.name}" was called` : `a tool was called (${called})`;
      return fail(ctx, `${what} but no call was expected`, { score: 0, details });
    }
    return pass(ctx, check.name ? `"${check.name}" was not called` : 'no tool was called', { score: 1, details });
  }

  if (!check.name) {
    return fail(ctx, 'tool_call check needs "name" (or "called: false")', { score: 0, details });
  }

  const named = calls.filter((c) => c.name === check.name);
  if (named.length === 0) {
    const reason =
      calls.length === 0
        ? `expected a call to "${check.name}" but no tool was called`
        : `expected a call to "${check.name}" but the response called ${called}`;
    return fail(ctx, reason, { score: 0, details });
  }

  const matching = check.args === undefined ? named : named.filter((c) => argsMatch(c.args, check.args));
  if (matching.length === 0) {
    const mismatch = describeMismatch(named[0]!.args, check.args, 'args');
    return fail(ctx, `"${check.name}" was called with other arguments: ${mismatch}`, { score: 0, details });
  }

  if (check.times !== undefined && matching.length !== check.times) {
    return fail(
      ctx,
      `expected ${check.times} call(s) to "${check.name}"${check.args ? ' with these arguments' : ''}, found ${matching.length}`,
      { score: 0, details },
    );
  }

  return pass(ctx, `"${check.name}" was called${check.args ? ' with the expected arguments' : ''}`, {
    score: 1,
    details,
  });
};

/** Reads tool calls from OpenAI, Anthropic, Gemini and plain `tool_calls` responses. */
export function findToolCalls(document: unknown): ToolCall[] {
  if (!isObject(document)) return Array.isArray(document) ? toCalls(document) : [];

  if (Array.isArray(document.choices)) {
    return document.choices.flatMap((choice) =>
      isObject(choice) && isObject(choice.message) && Array.isArray(choice.message.tool_calls)
        ? toCalls(choice.message.tool_calls)
        : [],
    );
  }
  if (Array.isArray(document.output)) {
    return toCalls(document.output.filter((item) => isObject(item) && item.type === 'function_call'));
  }
  if (Array.isArray(document.content)) {
    return toCalls(document.content.filter((item) => isObject(item) && item.type === 'tool_use'));
  }
  if (Array.isArray(document.candidates)) {
    return document.candidates.flatMap((candidate) =>
      isObject(candidate) && isObject(candidate.content) && Array.isArray(candidate.content.parts)
        ? toCalls(candidate.content.parts.map((part) => (isObject(part) ? part.functionCall : undefined)))
        : [],
    );
  }
  if (Array.isArray(document.tool_calls)) {
    return toCalls(document.tool_calls);
  }
  return [];
}

function callsAtPath(document: unknown, path: string): ToolCall[] {
  const matches = jsonPathQuery(document, path);
  const items = matches.length === 1 && Array.isArray(matches[0]) ? matches[0] : matches;
  return toCalls(items);
}

function toCalls(items: unknown[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const fn = isObject(item.function) ? item.function : undefined;
    const name = item.name ?? fn?.name;
    if (typeof name !== 'string') continue;
    const raw = item.arguments ?? item.args ?? item.input ?? fn?.arguments;
    calls.push({ name, args: parseArgs(raw) });
  }
  return calls;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Every key in `expected` must match; extra keys in `actual` are allowed. */
export function argsMatch(actual: unknown, expected: unknown): boolean {
  if (isObject(expected)) {
    if (!isObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) => argsMatch(actual[key], value));
  }
  return canonicalJson(actual) === canonicalJson(expected);
}

function describeMismatch(actual: unknown, expected: unknown, path: string): string {
  if (isObject(expected) && isObject(actual)) {
    for (const [key, value] of Object.entries(expected)) {
      if (!argsMatch(actual[key], value)) return describeMismatch(actual[key], value, `${path}.${key}`);
    }
  }
  return `${path} is ${actual === undefined ? 'missing' : JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
}

function describeCalls(calls: ToolCall[]): string {
  return calls.map((c) => `"${c.name}"`).join(', ');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
