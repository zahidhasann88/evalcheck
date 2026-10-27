import type { Grader, UsageCheck } from '../types.js';
import { fail, pass } from './helpers.js';

export const usageGrader: Grader = (ctx) => {
  const check = ctx.check as UsageCheck;
  const usage = ctx.attempt.usage;
  if (!usage) {
    return fail(ctx, 'the response did not report token usage; set target.response.usagePath if it is not found', {
      score: 0,
    });
  }

  const limits: Array<[string, number | undefined, number | undefined]> = [
    ['input tokens', usage.inputTokens, check.maxInputTokens],
    ['output tokens', usage.outputTokens, check.maxOutputTokens],
    ['total tokens', usage.totalTokens, check.maxTotalTokens],
    ['cost', usage.cost, check.maxCost],
  ];
  const problems: string[] = [];
  for (const [label, value, max] of limits) {
    if (max === undefined) continue;
    if (value === undefined) {
      problems.push(
        label === 'cost' ? 'cost is unknown; set target.pricing to use maxCost' : `the response did not report ${label}`,
      );
    } else if (value > max) {
      problems.push(`${label} ${value} exceed the budget of ${max}`);
    }
  }

  const details = { ...usage };
  if (problems.length > 0) return fail(ctx, problems.join('; '), { score: 0, details });
  return pass(ctx, `token usage within budget (${usage.totalTokens ?? '?'} tokens)`, { score: 1, details });
};
