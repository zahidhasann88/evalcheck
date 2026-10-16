import { createHash } from 'node:crypto';

/** Hashed over the raw (pre-interpolation) suite, so rotating a secret does not change it. */
export function hashSuite(suite: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(suite)).digest('hex').slice(0, 32)}`;
}

/** Deterministic JSON with sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = sortValue(source[key]);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

export function createRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}_${rand}`;
}
