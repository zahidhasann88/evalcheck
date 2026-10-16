import type { GradeContext, Grader } from '../types.js';
import { lexicalOverlap } from '../utils/text.js';
import { fail, pass } from './helpers.js';

export const lexicalOverlapGrader: Grader = (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'lexical_overlap' }>;
  const references = [...(check.reference ? [check.reference] : []), ...(check.references ?? [])];

  if (references.length === 0) {
    return fail(ctx, 'lexical_overlap check needs a reference text', { score: 0 });
  }

  const metric = check.metric ?? 'f1';
  const minScore = check.minScore ?? 0.6;

  const results = references.map((reference) => ({
    reference,
    ...lexicalOverlap(ctx.text, reference, metric),
  }));

  const best = results.reduce((a, b) => (b.score > a.score ? b : a));
  const details = {
    metric,
    minScore,
    bestScore: Number(best.score.toFixed(4)),
    scores: results.map((r) => Number(r.score.toFixed(4))),
    precision: Number(best.precision.toFixed(4)),
    recall: Number(best.recall.toFixed(4)),
    candidateTokens: best.candidateTokens,
    referenceTokens: best.referenceTokens,
  };

  if (best.score >= minScore) {
    return pass(ctx, `lexical overlap ${best.score.toFixed(3)} >= ${minScore}`, {
      score: best.score,
      details,
    });
  }
  return fail(ctx, `lexical overlap ${best.score.toFixed(3)} is below ${minScore}`, {
    score: best.score,
    details,
  });
};
