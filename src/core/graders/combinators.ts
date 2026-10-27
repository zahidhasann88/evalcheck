import type { AllOfCheck, AnyOfCheck, Check, CheckResult, GradeContext, Grader, NotCheck } from '../types.js';
import { fail, pass } from './helpers.js';
import { getGrader } from './index.js';

export const anyOfGrader: Grader = async (ctx) => {
  const results = await gradeEach(ctx, (ctx.check as AnyOfCheck).checks);
  const details = summarize(results);
  const score = Math.max(...results.map(scoreOf));
  const passed = results.find((r) => r.pass);
  if (passed) return pass(ctx, `${passed.id} passed: ${passed.reason}`, { score, details });
  return fail(ctx, `none of the checks passed: ${results.map(describe).join('; ')}`, { score, details });
};

export const allOfGrader: Grader = async (ctx) => {
  const results = await gradeEach(ctx, (ctx.check as AllOfCheck).checks);
  const details = summarize(results);
  const score = Math.min(...results.map(scoreOf));
  const failed = results.filter((r) => !r.pass);
  if (failed.length === 0) return pass(ctx, `all ${results.length} checks passed`, { score, details });
  return fail(ctx, failed.map(describe).join('; '), { score, details });
};

export const notGrader: Grader = async (ctx) => {
  const [result] = await gradeEach(ctx, [(ctx.check as NotCheck).check]);
  const details = summarize([result!]);
  const score = 1 - scoreOf(result!);
  if (result!.error) return fail(ctx, `could not run ${describe(result!)}`, { score: 0, details });
  if (result!.pass) return fail(ctx, `expected ${result!.id} to fail, but it passed: ${result!.reason}`, { score, details });
  return pass(ctx, `${result!.id} failed as expected: ${result!.reason}`, { score, details });
};

async function gradeEach(ctx: GradeContext, checks: Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const id = check.id ?? check.type;
    try {
      const result = await getGrader(check.type)({ ...ctx, check });
      results.push({ ...result, id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ id, type: check.type, pass: false, reason: `grader error: ${message}`, error: message });
    }
  }
  return results;
}

function describe(result: CheckResult): string {
  return `${result.id}: ${result.reason}`;
}

function scoreOf(result: CheckResult): number {
  return result.score ?? (result.pass ? 1 : 0);
}

function summarize(results: CheckResult[]): Record<string, unknown> {
  return { checks: results.map((r) => ({ id: r.id, type: r.type, pass: r.pass, reason: r.reason })) };
}
