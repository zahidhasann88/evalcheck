import type { GradeContext, Grader } from '../types.js';
import { cosineSimilarity } from './embedding/local.js';
import { fail, pass } from './helpers.js';

export const similarityGrader: Grader = async (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'similarity' }>;
  const references = [...(check.reference ? [check.reference] : []), ...(check.references ?? [])];

  if (references.length === 0) {
    return fail(ctx, 'similarity check needs a reference text', { score: 0 });
  }

  const provider = ctx.services.embeddings;
  const vectors = await provider.embed([ctx.text, ...references]);
  const candidate = vectors[0];
  if (!candidate) {
    return fail(ctx, 'embedding backend returned no vector for the response', { score: 0 });
  }

  const scores = vectors.slice(1).map((vector) => cosineSimilarity(candidate, vector));
  const best = Math.max(...scores);
  const minScore = check.minScore ?? 0.8;

  const details = {
    model: provider.model,
    ...(provider.revision ? { revision: provider.revision } : {}),
    minScore,
    bestScore: Number(best.toFixed(4)),
    scores: scores.map((s) => Number(s.toFixed(4))),
    references: references.length,
  };

  if (best >= minScore) {
    return pass(ctx, `similarity ${best.toFixed(3)} >= ${minScore}`, {
      score: best,
      details,
    });
  }
  return fail(ctx, `similarity ${best.toFixed(3)} is below ${minScore}`, {
    score: best,
    details,
  });
};
