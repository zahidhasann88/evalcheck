import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { z, type ZodIssue } from 'zod';

import { ConfigError, type ConfigIssue } from '../errors.js';
import { hashSuite } from '../utils/hash.js';
import type {
  CaseSpec,
  Check,
  EmbeddingConfig,
  Suite,
  SuiteDefaults,
  TargetSpec,
} from '../types.js';
import { SuiteDefinitionSchema, type SuiteDefinitionOutput } from './schema.js';

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

type YamlDocument = ReturnType<typeof parseDocument>;

export interface LoadSuiteOptions {
  /** Directory used to resolve relative paths (defaults to the suite's dir). */
  baseDir?: string;
  /** Environment used for `${VAR}` interpolation during validation. */
  env?: NodeJS.ProcessEnv;
}

export interface LoadedSuite {
  suite: Suite;
  /** Hash over the raw, pre-interpolation suite definition. */
  hash: string;
  sourcePath: string;
}

export async function loadSuite(
  filePath: string,
  options: LoadSuiteOptions = {},
): Promise<LoadedSuite> {
  const absolute = path.resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read suite file "${filePath}"`, [
      { path: '', message: err instanceof Error ? err.message : String(err) },
    ]);
  }
  const parsed = parseSuiteSource(raw, absolute, options);
  return parsed;
}

export function parseSuiteSource(
  raw: string,
  sourcePath: string,
  options: LoadSuiteOptions = {},
): LoadedSuite {
  const absolute = path.resolve(sourcePath);
  const baseDir = options.baseDir ?? path.dirname(absolute);
  const isJson = absolute.toLowerCase().endsWith('.json');

  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, {
    lineCounter,
    keepSourceTokens: false,
    uniqueKeys: false,
  });

  let value: unknown;

  if (isJson) {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const match = /position (\d+)/.exec(message);
      const location = match
        ? (() => {
            const pos = lineCounter.linePos(Number.parseInt(match[1]!, 10));
            return `line ${pos.line}, column ${pos.col}`;
          })()
        : undefined;
      throw new ConfigError(`Cannot parse suite file "${sourcePath}" as JSON`, [
        { path: '', message, location },
      ]);
    }
  } else {
    const yamlErrors = doc.errors.map((e) => e.message);
    if (yamlErrors.length > 0) {
      const issues: ConfigIssue[] = doc.errors.map((e) => {
        const loc = e.linePos ? `line ${e.linePos[0].line}, column ${e.linePos[0].col}` : undefined;
        return { path: '', message: e.message, location: loc };
      });
      throw new ConfigError(`Cannot parse suite file "${sourcePath}"`, issues);
    }
    value = doc.toJS({ maxAliasCount: 100 });
  }

  const result = SuiteDefinitionSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => toConfigIssue(issue, doc, lineCounter, sourcePath));
    throw new ConfigError(`Invalid suite file "${sourcePath}"`, issues);
  }

  const definition = result.data as SuiteDefinitionOutput;
  assertReferences(definition, doc, lineCounter, sourcePath);
  const suite = normalizeSuite(definition, { baseDir, sourcePath: absolute });
  return { suite, hash: hashSuite(stripUndefined(definition)), sourcePath: absolute };
}

export interface NormalizeOptions {
  baseDir: string;
  sourcePath?: string;
}

export function normalizeSuite(definition: SuiteDefinitionOutput, options: NormalizeOptions): Suite {
  const defaults: SuiteDefaults = definition.defaults ?? {};
  const target = normalizeTarget(definition.target);
  const embedding: EmbeddingConfig = {
    model: definition.embedding?.model ?? DEFAULT_EMBEDDING_MODEL,
    ...(definition.embedding?.revision ? { revision: definition.embedding.revision } : {}),
    ...(definition.embedding?.modelPath
      ? { modelPath: path.resolve(options.baseDir, definition.embedding.modelPath) }
      : {}),
    ...(definition.embedding?.cacheDir
      ? { cacheDir: path.resolve(options.baseDir, definition.embedding.cacheDir) }
      : {}),
  };

  const rawCases = definition.cases ?? [];
  const seen = new Set<string>();
  const cases: CaseSpec[] = rawCases.map((caseSpec) => {
    if (seen.has(caseSpec.id)) {
      throw new ConfigError(`Duplicate case id "${caseSpec.id}"`, [
        { path: `cases.${caseSpec.id}`, message: 'case ids must be unique' },
      ]);
    }
    seen.add(caseSpec.id);
    return normalizeCase(caseSpec, defaults, options.baseDir);
  });

  const suite: Suite = {
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    target,
    ...(defaults.repeat !== undefined ? {} : {}),
    defaults: {
      ...(defaults.repeat !== undefined ? { repeat: defaults.repeat } : {}),
      ...(defaults.checks ? { checks: defaults.checks } : {}),
      ...(defaults.vars ? { vars: defaults.vars } : {}),
    },
    cases,
    embedding,
    baseDir: options.baseDir,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
  };
  return suite;
}

function normalizeTarget(target: SuiteDefinitionOutput['target']): TargetSpec {
  return {
    url: target.url,
    method: target.method.toUpperCase(),
    ...(target.headers ? { headers: target.headers } : {}),
    ...(target.query ? { query: target.query } : {}),
    ...(target.body !== undefined ? { body: target.body } : {}),
    preset: target.preset,
    response: {
      ...(target.response?.textPath ? { textPath: target.response.textPath } : {}),
      ...(target.response?.chunkPath ? { chunkPath: target.response.chunkPath } : {}),
      stream:
        target.response?.stream === 'sse' || target.response?.stream === true
          ? 'sse'
          : false,
      ...(target.response?.status !== undefined ? { status: target.response.status } : {}),
    },
    timeoutMs: target.timeoutMs,
    retries: target.retries ?? { max: 0, on: [], backoffMs: 0 },
    ...(target.model ? { model: target.model } : {}),
    ...(target.system ? { system: target.system } : {}),
    ...(target.maxTokens !== undefined ? { maxTokens: target.maxTokens } : {}),
    ...(target.temperature !== undefined ? { temperature: target.temperature } : {}),
  };
}

function normalizeCase(
  caseSpec: NonNullable<SuiteDefinitionOutput['cases']>[number],
  defaults: SuiteDefaults,
  baseDir: string,
): CaseSpec {
  const checks = [...(defaults.checks ?? []), ...(caseSpec.checks ?? [])].map((check) =>
    normalizeCheck(check, baseDir),
  );
  return {
    id: caseSpec.id,
    ...(caseSpec.input !== undefined ? { input: caseSpec.input } : {}),
    vars: { ...(defaults.vars ?? {}), ...(caseSpec.vars ?? {}) },
    ...(checks.length > 0 ? { checks } : {}),
    ...(caseSpec.repeat ?? defaults.repeat ? { repeat: caseSpec.repeat ?? defaults.repeat } : {}),
    ...(caseSpec.description ? { description: caseSpec.description } : {}),
    ...(caseSpec.tags ? { tags: caseSpec.tags } : {}),
    ...(caseSpec.skip !== undefined ? { skip: caseSpec.skip } : {}),
  };
}

function normalizeCheck(check: Check, baseDir: string): Check {
  switch (check.type) {
    case 'custom':
      return { ...check, module: path.resolve(baseDir, check.module) };
    case 'json_schema': {
      const next: Check = { ...check };
      if (next.schemaFile) next.schemaFile = path.resolve(baseDir, next.schemaFile);
      if (next.$ref) next.$ref = path.resolve(baseDir, next.$ref);
      return next;
    }
    case 'similarity': {
      const next: Check = { ...check };
      if (next.modelPath) next.modelPath = path.resolve(baseDir, next.modelPath);
      return next;
    }
    default:
      return check;
  }
}

/** Constraints spanning several fields, which a Zod union member cannot express. */
function assertReferences(
  definition: SuiteDefinitionOutput,
  doc: YamlDocument,
  lineCounter: LineCounter,
  sourcePath: string,
): void {
  const issues: ConfigIssue[] = [];
  const groups: Array<{ checks: Check[]; path: string[] }> = [];

  if (definition.defaults?.checks) {
    groups.push({ checks: definition.defaults.checks as Check[], path: ['defaults', 'checks'] });
  }
  definition.cases?.forEach((caseSpec, index) => {
    if (caseSpec.checks) {
      groups.push({ checks: caseSpec.checks as Check[], path: ['cases', String(index), 'checks'] });
    }
  });

  for (const group of groups) {
    group.checks.forEach((check, index) => {
      if (check.type !== 'similarity' && check.type !== 'lexical_overlap') return;
      if (check.reference !== undefined || check.references !== undefined) return;
      const segments = [...group.path, String(index)];
      const location = locate(doc, lineCounter, segments);
      issues.push({
        path: segments.join('.'),
        message: `${check.type} check requires "reference" or "references"`,
        ...(location ? { location: `${path.basename(sourcePath)}: ${location}` } : {}),
      });
    });
  }

  if (issues.length > 0) {
    throw new ConfigError(`Invalid suite file "${sourcePath}"`, issues);
  }
}

function toConfigIssue(
  issue: ZodIssue,
  doc: YamlDocument,
  lineCounter: LineCounter,
  sourcePath: string,
): ConfigIssue {
  const segments = issue.path.map((p) => String(p));
  const location = locate(doc, lineCounter, segments);
  return {
    path: segments.join('.') || '<root>',
    message: issue.message,
    ...(location ? { location: `${path.basename(sourcePath)}: ${location}` } : {}),
  };
}

function locate(
  doc: YamlDocument,
  lineCounter: LineCounter,
  segments: string[],
): string | undefined {
  const tryPath = (candidate: string[]): string | undefined => {
    try {
      const node = doc.getIn(candidate as Array<string | number>, true) as
        | { range?: [number, number, number] }
        | null
        | undefined;
      if (node && Array.isArray(node.range) && typeof node.range[0] === 'number') {
        const pos = lineCounter.linePos(node.range[0]);
        return `line ${pos.line}, column ${pos.col}`;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const direct = tryPath(segments);
  if (direct) return direct;

  for (let i = segments.length - 1; i > 0; i--) {
    const parent = tryPath(segments.slice(0, i));
    if (parent) return parent;
  }
  return tryPath([]);
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Parses a suite and returns only the definition (useful for `validate`). */
export function safeParseSuite(raw: unknown): z.SafeParseReturnType<unknown, SuiteDefinitionOutput> {
  return SuiteDefinitionSchema.safeParse(raw);
}
