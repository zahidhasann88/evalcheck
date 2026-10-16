import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from '../errors.js';
import type { CaseSpec, Check } from '../types.js';

export interface DatasetOptions {
  idColumn?: string;
  inputColumn?: string;
  varsColumns?: string[];
  checksColumn?: string;
  tagsColumn?: string;
  /** Checks applied to every dataset case (merged with per-row checks). */
  baseChecks?: Check[];
}

export interface Dataset {
  cases: CaseSpec[];
  columns: string[];
}

export async function loadDataset(filePath: string, options: DatasetOptions = {}): Promise<Dataset> {
  const absolute = path.resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read dataset file "${filePath}"`, [
      { path: '', message: err instanceof Error ? err.message : String(err) },
    ]);
  }

  const ext = path.extname(absolute).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') {
    return fromJsonl(raw, absolute, options);
  }
  if (ext === '.csv') {
    return fromCsv(raw, absolute, options);
  }
  if (ext === '.json') {
    return fromJson(raw, absolute, options);
  }
  throw new ConfigError(`Unsupported dataset format "${ext}" for "${filePath}"`, [
    { path: '', message: 'Supported formats: .jsonl, .ndjson, .csv, .json' },
  ]);
}

function fromJsonl(raw: string, sourcePath: string, options: DatasetOptions): Dataset {
  const rows: Record<string, unknown>[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('expected a JSON object per line');
      }
      rows.push(parsed as Record<string, unknown>);
    } catch (err) {
      throw new ConfigError(`Invalid JSONL in "${sourcePath}"`, [
        { path: `line ${i + 1}`, message: err instanceof Error ? err.message : String(err) },
      ]);
    }
  }
  return buildCases(rows, options);
}

function fromJson(raw: string, sourcePath: string, options: DatasetOptions): Dataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in "${sourcePath}"`, [
      { path: '', message: err instanceof Error ? err.message : String(err) },
    ]);
  }
  const rows = Array.isArray(parsed)
    ? (parsed as unknown[])
    : typeof parsed === 'object' && parsed !== null
      ? Object.values(parsed as Record<string, unknown>)
      : [];
  const normalized = rows.map((row) => {
    if (typeof row !== 'object' || row === null) {
      throw new ConfigError(`Invalid dataset in "${sourcePath}"`, [
        { path: '', message: 'expected an array of objects' },
      ]);
    }
    return row as Record<string, unknown>;
  });
  return buildCases(normalized, options);
}

function fromCsv(raw: string, sourcePath: string, options: DatasetOptions): Dataset {
  const records = parseCsv(raw);
  if (records.length === 0) {
    throw new ConfigError(`Empty dataset "${sourcePath}"`, [{ path: '', message: 'no rows found' }]);
  }
  const header = records[0]!;
  const rows = records.slice(1).map((cells) => {
    const row: Record<string, unknown> = {};
    header.forEach((key, i) => {
      row[key] = cells[i] ?? '';
    });
    return row;
  });
  return buildCases(rows, options);
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 0 && !(r.length === 1 && r[0]!.trim() === ''));
}

function buildCases(rows: Record<string, unknown>[], options: DatasetOptions): Dataset {
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const idColumn = options.idColumn ?? 'id';
  const inputColumn = options.inputColumn ?? 'input';
  const checksColumn = options.checksColumn;
  const tagsColumn = options.tagsColumn;
  const varsColumns =
    options.varsColumns ??
    columns.filter((c) => c !== idColumn && c !== inputColumn && c !== checksColumn && c !== tagsColumn);

  const cases: CaseSpec[] = [];
  rows.forEach((row, index) => {
    const id = row[idColumn];
    if (id === undefined || id === null || String(id).trim() === '') {
      throw new ConfigError(`Dataset row ${index + 1} is missing the id column "${idColumn}"`, [
        { path: `row ${index + 1}.${idColumn}`, message: 'required' },
      ]);
    }
    const input = row[inputColumn];
    const vars: Record<string, unknown> = {};
    for (const column of varsColumns) {
      if (column in row) vars[column] = row[column];
    }

    let checks: Check[] = [...(options.baseChecks ?? [])];
    if (checksColumn && row[checksColumn] !== undefined && row[checksColumn] !== '') {
      const parsed = parseChecks(row[checksColumn], index + 1, checksColumn);
      checks = [...checks, ...parsed];
    }

    const caseSpec: CaseSpec = {
      id: String(id),
      ...(input !== undefined && input !== null ? { input: String(input) } : {}),
      vars,
      ...(checks.length > 0 ? { checks } : {}),
    };
    if (tagsColumn && row[tagsColumn]) {
      const tags = String(row[tagsColumn])
        .split(/[;,|]/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (tags.length > 0) caseSpec.tags = tags;
    }
    cases.push(caseSpec);
  });

  return { cases, columns };
}

function parseChecks(value: unknown, rowNumber: number, column: string): Check[] {
  if (Array.isArray(value)) return value as Check[];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as Check[];
    throw new Error('expected a JSON array of checks');
  } catch (err) {
    throw new ConfigError(`Invalid checks in dataset column "${column}"`, [
      {
        path: `row ${rowNumber}.${column}`,
        message: err instanceof Error ? err.message : String(err),
      },
    ]);
  }
}
