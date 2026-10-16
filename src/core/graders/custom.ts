import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AttemptResult, CaseSpec, CheckResult, CustomCheck, GradeContext, Grader, Suite } from '../types.js';

export interface CustomResponse {
  text: string;
  /** Parsed JSON of the extracted text (if any). */
  json: unknown;
  status?: number;
  latencyMs: number;
  /** Time to first token (streaming only). */
  ttftMs?: number;
  attempt: AttemptResult;
}

export interface CustomContext {
  case: CaseSpec;
  suite: Suite;
  attempt: AttemptResult;
  check: CustomCheck;
  logger: GradeContext['logger'];
}

export interface CustomVerdict {
  pass: boolean;
  score?: number;
  reason?: string;
}

export type CustomCheckFn = (
  response: CustomResponse,
  ctx: CustomContext,
) => CustomVerdict | Promise<CustomVerdict>;

const moduleCache = new Map<string, Promise<CustomCheckFn>>();

export function clearCustomCheckCache(): void {
  moduleCache.clear();
}

export const customGrader: Grader = async (ctx) => {
  const check = ctx.check as CustomCheck;
  const fn = await loadCustomCheck(check.module, check.export);

  const response: CustomResponse = {
    text: ctx.text,
    json: ctx.json,
    ...(ctx.attempt.status !== undefined ? { status: ctx.attempt.status } : {}),
    latencyMs: ctx.attempt.latencyMs,
    ...(ctx.attempt.ttftMs !== undefined ? { ttftMs: ctx.attempt.ttftMs } : {}),
    attempt: ctx.attempt,
  };

  const customCtx: CustomContext = {
    case: ctx.caseSpec,
    suite: ctx.suite,
    attempt: ctx.attempt,
    check,
    logger: ctx.logger,
  };

  const verdict = await fn(response, customCtx);
  const result: CheckResult = {
    id: ctx.check.id ?? 'custom',
    type: 'custom',
    pass: Boolean(verdict?.pass),
    reason: verdict?.reason ?? (verdict?.pass ? 'custom check passed' : 'custom check failed'),
    ...(verdict?.score !== undefined ? { score: verdict.score } : {}),
    ...(ctx.check.optional !== undefined ? { optional: ctx.check.optional } : {}),
  };
  return result;
};

export async function loadCustomCheck(
  modulePath: string,
  exportName = 'default',
): Promise<CustomCheckFn> {
  const absolute = path.resolve(modulePath);
  const key = `${absolute}#${exportName}`;
  const cached = moduleCache.get(key);
  if (cached) return cached;
  const promise = importCustomCheck(absolute, exportName);
  moduleCache.set(key, promise);
  return promise;
}

async function importCustomCheck(absolute: string, exportName: string): Promise<CustomCheckFn> {
  if (!absolute.endsWith('.ts') && !absolute.endsWith('.tsx')) {
    const mod = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
    return pickExport(mod, absolute, exportName);
  }

  const transpiled = await transpileTypeScript(absolute);
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)) as Record<
    string,
    unknown
  >;
  return pickExport(mod, absolute, exportName);
}

function pickExport(mod: Record<string, unknown>, absolute: string, exportName: string): CustomCheckFn {
  const candidate = exportName === 'default' ? (mod.default ?? mod.check) : mod[exportName];
  if (typeof candidate !== 'function') {
    throw new Error(
      `Custom check module "${absolute}" does not export a function named "${exportName}". ` +
        'Export either a default function or the name given in `export:`.',
    );
  }
  return candidate as CustomCheckFn;
}

async function transpileTypeScript(absolute: string): Promise<string> {
  const require = createRequire(import.meta.url);
  let ts: typeof import('typescript');
  try {
    ts = require('typescript') as typeof import('typescript');
  } catch {
    throw new Error(
      `Cannot import the TypeScript custom check "${absolute}": the optional "typescript" package is not installed. ` +
        'Write the check in JavaScript (.mjs) or install typescript as a dev dependency.',
    );
  }
  const source = require('node:fs').readFileSync(absolute, 'utf8') as string;
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: absolute,
  });
  return output.outputText;
}
