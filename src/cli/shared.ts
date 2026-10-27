import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { allCaseChecks } from '../core/config/loader.js';
import { ConfigError, EvalcheckError, EXIT_CONFIG_ERROR } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Logger, Suite } from '../core/types.js';

export interface GlobalOptions {
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
}

export function makeLogger(options: GlobalOptions): Logger {
  const level = options.verbose ? 'debug' : options.quiet ? 'error' : 'warn';
  return createLogger(level, {
    warn: (message) => process.stderr.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
    debug: (message) => process.stderr.write(`${message}\n`),
    info: (message) => process.stderr.write(`${message}\n`),
  });
}

export function useColor(options: GlobalOptions): boolean {
  if (options.color === false) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

export function runFileName(suiteName: string, date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  const safeSuite = suiteName.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${stamp}_${safeSuite}.json`;
}

export async function writeArtifact(filePath: string, content: string): Promise<string> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
  return absolute;
}

export async function ensureDir(dir: string): Promise<string> {
  const absolute = path.resolve(dir);
  await mkdir(absolute, { recursive: true });
  return absolute;
}

export function suiteNeedsEmbeddings(suite: Suite): boolean {
  return suite.cases.some((caseSpec) =>
    allCaseChecks(caseSpec).some((check) => check.type === 'similarity'),
  );
}

/** Reads git info from CI environment variables instead of spawning git. */
export function readGitInfo(env: NodeJS.ProcessEnv = process.env): { commit?: string; branch?: string } | undefined {
  const commit = env.GITHUB_SHA ?? env.CI_COMMIT_SHA ?? env.GIT_COMMIT;
  const branch =
    env.GITHUB_REF_NAME ??
    env.CI_COMMIT_BRANCH ??
    (env.GITHUB_REF?.startsWith('refs/heads/') ? env.GITHUB_REF.slice('refs/heads/'.length) : undefined);
  if (!commit && !branch) return undefined;
  return { ...(commit ? { commit } : {}), ...(branch ? { branch } : {}) };
}

export function reportError(error: unknown): number {
  if (error instanceof EvalcheckError) {
    process.stderr.write(`\n✘ ${error.message}\n`);
    for (const detail of error.details) {
      process.stderr.write(`  ${detail}\n`);
    }
    return error.exitCode;
  }
  if (error instanceof Error) {
    process.stderr.write(`\n✘ ${error.message}\n`);
    if (process.env.EVALCHECK_DEBUG && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    return EXIT_CONFIG_ERROR;
  }
  process.stderr.write(`\n✘ ${String(error)}\n`);
  return EXIT_CONFIG_ERROR;
}

export function configError(message: string, details: string[] = []): ConfigError {
  return new ConfigError(
    message,
    details.map((message) => ({ path: '', message })),
  );
}
