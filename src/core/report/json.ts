import type { RunResult } from '../types.js';

export const JSON_REPORT_SCHEMA_VERSION = '1.0';

export function reportToJson(result: RunResult, pretty = true): string {
  const payload = {
    ...result,
    schemaVersion: result.schemaVersion ?? JSON_REPORT_SCHEMA_VERSION,
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

export function parseRunFile(content: string): RunResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON run file: ${(err as Error).message}`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid run file: expected a JSON object');
  }
  const record = parsed as Partial<RunResult>;
  if (!record.meta || !record.totals || !Array.isArray(record.cases)) {
    throw new Error('Invalid run file: missing "meta", "totals" or "cases"');
  }
  if (!record.schemaVersion) {
    record.schemaVersion = JSON_REPORT_SCHEMA_VERSION;
  }
  return record as RunResult;
}
