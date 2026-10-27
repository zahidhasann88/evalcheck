import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { ConfigError } from '../errors.js';
import type { Check } from '../types.js';
import { DefaultsSchema, EmbeddingConfigSchema, TargetSpecSchema } from './schema.js';

export const CONFIG_FILE_NAMES = ['evalcheck.config.yaml', 'evalcheck.config.yml', 'evalcheck.config.json'];

const SUITE_EXTENSIONS = ['.yaml', '.yml', '.json'];

export const SharedConfigSchema = z
  .object({
    $schema: z.string().optional(),
    target: TargetSpecSchema.partial().optional(),
    defaults: DefaultsSchema.optional(),
    embedding: EmbeddingConfigSchema.optional(),
  })
  .strict()
  .describe('Settings shared by every suite in the same directory (evalcheck.config.yaml).');

export interface SharedConfig {
  path: string;
  raw: Record<string, unknown>;
}

export async function loadSharedConfig(file: string): Promise<SharedConfig> {
  const absolute = path.resolve(file);
  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file "${file}"`, [{ path: '', message: (err as Error).message }]);
  }
  let raw: unknown;
  try {
    raw = absolute.endsWith('.json') ? JSON.parse(content) : parseYaml(content);
  } catch (err) {
    throw new ConfigError(`Cannot parse config file "${file}"`, [{ path: '', message: (err as Error).message }]);
  }
  const result = SharedConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(
      `Invalid config file "${file}"`,
      result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.') || '<root>', message: issue.message })),
    );
  }
  return { path: absolute, raw: resolvePaths((raw ?? {}) as Record<string, unknown>, path.dirname(absolute)) };
}

/** Looks for evalcheck.config.(yaml|yml|json) next to the suite file. */
export async function findSharedConfig(suiteFile: string): Promise<string | undefined> {
  const dir = path.dirname(path.resolve(suiteFile));
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Suite values win; headers, query, response and vars are merged; shared checks run first. */
export function applySharedConfig(shared: SharedConfig, suite: unknown): unknown {
  if (!isObject(suite)) return suite;
  const target = mergeTargets(shared.raw.target, suite.target);

  const sharedDefaults = isObject(shared.raw.defaults) ? shared.raw.defaults : {};
  const suiteDefaults = isObject(suite.defaults) ? suite.defaults : {};
  const defaults: Record<string, unknown> = { ...sharedDefaults, ...suiteDefaults };
  if (isObject(sharedDefaults.vars) || isObject(suiteDefaults.vars)) {
    defaults.vars = { ...(isObject(sharedDefaults.vars) ? sharedDefaults.vars : {}), ...(isObject(suiteDefaults.vars) ? suiteDefaults.vars : {}) };
  }
  if (Array.isArray(sharedDefaults.checks) || Array.isArray(suiteDefaults.checks)) {
    defaults.checks = [
      ...(Array.isArray(sharedDefaults.checks) ? sharedDefaults.checks : []),
      ...(Array.isArray(suiteDefaults.checks) ? suiteDefaults.checks : []),
    ];
  }

  const merged: Record<string, unknown> = { ...suite, target };
  if (Object.keys(defaults).length > 0) merged.defaults = defaults;
  if (suite.embedding === undefined && shared.raw.embedding !== undefined) merged.embedding = shared.raw.embedding;
  return merged;
}

/** Overrides win; headers, query and response are merged key by key. */
export function mergeTargets(base: unknown, override: unknown): Record<string, unknown> {
  const baseTarget = isObject(base) ? base : {};
  const overrideTarget = isObject(override) ? override : {};
  const target: Record<string, unknown> = { ...baseTarget, ...overrideTarget };
  for (const key of ['headers', 'query', 'response']) {
    if (isObject(baseTarget[key]) || isObject(overrideTarget[key])) {
      target[key] = {
        ...(isObject(baseTarget[key]) ? baseTarget[key] : {}),
        ...(isObject(overrideTarget[key]) ? overrideTarget[key] : {}),
      };
    }
  }
  return target;
}

/** Expands directories into the suite files they contain (not recursive, config files excluded). */
export async function expandSuitePaths(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    let info;
    try {
      info = await stat(input);
    } catch (err) {
      throw new ConfigError(`Cannot read suite file "${input}"`, [{ path: '', message: (err as Error).message }]);
    }
    if (!info.isDirectory()) {
      files.push(input);
      continue;
    }
    const entries = (await readdir(input))
      .filter((name) => SUITE_EXTENSIONS.includes(path.extname(name).toLowerCase()))
      .filter((name) => !CONFIG_FILE_NAMES.includes(name.toLowerCase()))
      .sort();
    if (entries.length === 0) {
      throw new ConfigError(`No suite files found in "${input}"`, [
        { path: '', message: `expected ${SUITE_EXTENSIONS.join(', ')} files` },
      ]);
    }
    files.push(...entries.map((name) => path.join(input, name)));
  }
  return files;
}

function resolvePaths(raw: Record<string, unknown>, dir: string): Record<string, unknown> {
  const out = { ...raw };
  if (isObject(out.defaults) && Array.isArray(out.defaults.checks)) {
    out.defaults = { ...out.defaults, checks: (out.defaults.checks as Check[]).map((check) => resolveCheck(check, dir)) };
  }
  if (isObject(out.embedding)) {
    const embedding = { ...out.embedding };
    for (const key of ['modelPath', 'cacheDir']) {
      if (typeof embedding[key] === 'string') embedding[key] = path.resolve(dir, embedding[key]);
    }
    out.embedding = embedding;
  }
  return out;
}

function resolveCheck(check: Check, dir: string): Check {
  switch (check.type) {
    case 'custom':
      return { ...check, module: path.resolve(dir, check.module) };
    case 'json_schema':
      return {
        ...check,
        ...(check.schemaFile ? { schemaFile: path.resolve(dir, check.schemaFile) } : {}),
        ...(check.$ref ? { $ref: path.resolve(dir, check.$ref) } : {}),
      };
    case 'similarity':
      return check.modelPath ? { ...check, modelPath: path.resolve(dir, check.modelPath) } : check;
    case 'any_of':
    case 'all_of':
      return { ...check, checks: check.checks.map((inner) => resolveCheck(inner, dir)) };
    case 'not':
      return { ...check, check: resolveCheck(check.check, dir) };
    default:
      return check;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
