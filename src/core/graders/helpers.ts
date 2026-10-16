import type { CheckResult, GradeContext } from '../types.js';

/** Stable identifier for a check when the suite does not provide one. */
export function checkId(ctx: GradeContext): string {
  if (ctx.check.id) return ctx.check.id;
  return ctx.check.type;
}

export function pass(
  ctx: GradeContext,
  reason: string,
  extra: Partial<CheckResult> = {},
): CheckResult {
  return {
    id: checkId(ctx),
    type: ctx.check.type,
    pass: true,
    reason,
    ...(extra.optional !== undefined ? { optional: extra.optional } : {}),
    ...(extra.score !== undefined ? { score: extra.score } : {}),
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

export function fail(
  ctx: GradeContext,
  reason: string,
  extra: Partial<CheckResult> = {},
): CheckResult {
  return {
    id: checkId(ctx),
    type: ctx.check.type,
    pass: false,
    reason,
    ...(extra.optional !== undefined ? { optional: extra.optional } : {}),
    ...(extra.score !== undefined ? { score: extra.score } : {}),
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

export function excerpt(value: string, max = 160): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
