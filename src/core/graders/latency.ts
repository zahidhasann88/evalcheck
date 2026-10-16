import type { GradeContext, Grader } from '../types.js';
import { fail, pass } from './helpers.js';

/**
 * Latency grader.
 *
 * `maxMs`/`minMs` apply to the total request time; `ttftMaxMs` applies to the
 * time to first token, which is only measured for streaming responses.
 */
export const latencyGrader: Grader = (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'latency' }>;
  const latency = ctx.attempt.latencyMs;
  const ttft = ctx.attempt.ttftMs;

  const problems: string[] = [];

  if (check.maxMs !== undefined && latency > check.maxMs) {
    problems.push(`latency ${Math.round(latency)}ms exceeds the budget of ${check.maxMs}ms`);
  }
  if (check.minMs !== undefined && latency < check.minMs) {
    problems.push(`latency ${Math.round(latency)}ms is below the minimum of ${check.minMs}ms`);
  }
  if (check.ttftMaxMs !== undefined) {
    if (ttft === undefined) {
      problems.push(
        'time to first token was not measured (the response was not streamed); set target.response.stream to "sse" to use ttftMaxMs',
      );
    } else if (ttft > check.ttftMaxMs) {
      problems.push(`time to first token ${Math.round(ttft)}ms exceeds the budget of ${check.ttftMaxMs}ms`);
    }
  }

  if (problems.length === 0) {
    return pass(ctx, `latency ${Math.round(latency)}ms is within budget`, {
      score: 1,
      details: {
        latencyMs: latency,
        ttftMs: ttft,
        maxMs: check.maxMs,
        minMs: check.minMs,
        ttftMaxMs: check.ttftMaxMs,
      },
    });
  }

  return fail(ctx, problems.join('; '), {
    score: 0,
    details: { latencyMs: latency, ttftMs: ttft },
  });
};
