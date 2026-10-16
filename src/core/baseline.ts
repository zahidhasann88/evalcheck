import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from './errors.js';
import { parseRunFile } from './report/json.js';
import type { RunResult } from './types.js';

export const DEFAULT_BASELINE_DIR = '.evalcheck';

export interface SaveBaselineOptions {
  /** Directory that stores the baseline files. */
  dir?: string;
  /** Name of the baseline (file name without extension). */
  name?: string;
}

export function baselineFilePath(dir = DEFAULT_BASELINE_DIR, name = 'baseline'): string {
  return path.resolve(dir, `${name}.json`);
}

export async function saveBaseline(
  runFile: string,
  options: SaveBaselineOptions = {},
): Promise<{ path: string; run: RunResult }> {
  const source = path.resolve(runFile);
  let content: string;
  try {
    content = await readFile(source, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read run file "${runFile}"`, [
      { path: '', message: err instanceof Error ? err.message : String(err) },
    ]);
  }
  const run = parseRunFile(content);

  const dir = path.resolve(options.dir ?? DEFAULT_BASELINE_DIR);
  await mkdir(dir, { recursive: true });
  const target = baselineFilePath(dir, options.name ?? 'baseline');
  await copyFile(source, target);
  return { path: target, run };
}

/**
 * Resolves a baseline reference. A path to an existing file is used as is; a
 * bare name such as `baseline` or `nightly` refers to `<dir>/<name>.json`.
 */
export async function resolveBaselinePath(ref: string, dir = DEFAULT_BASELINE_DIR): Promise<string> {
  const direct = path.resolve(ref);
  if (await isFile(direct)) return direct;
  const isBareName = !ref.endsWith('.json') && !/[\\/]/.test(ref);
  return isBareName ? baselineFilePath(dir, ref) : direct;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function loadBaseline(file: string, dir = DEFAULT_BASELINE_DIR): Promise<RunResult> {
  const absolute = await resolveBaselinePath(file, dir);
  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read baseline file "${file}"`, [
      { path: '', message: err instanceof Error ? err.message : String(err) },
    ]);
  }
  return parseRunFile(content);
}

export interface BaselineInfo {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export async function listBaselines(dir = DEFAULT_BASELINE_DIR): Promise<BaselineInfo[]> {
  const absolute = path.resolve(dir);
  let entries: string[];
  try {
    entries = await readdir(absolute);
  } catch {
    return [];
  }
  const out: BaselineInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(absolute, entry);
    const info = await stat(full);
    out.push({
      name: entry.replace(/\.json$/, ''),
      path: full,
      size: info.size,
      modifiedAt: new Date(info.mtime).toISOString(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
