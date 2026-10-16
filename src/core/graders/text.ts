import type { GradeContext, Grader } from '../types.js';
import { applyNormalizers, countChars, countWords } from '../utils/text.js';
import { excerpt, fail, pass } from './helpers.js';

export const containsGrader: Grader = (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'contains' }>;
  const haystack = check.caseInsensitive ? ctx.text.toLowerCase() : ctx.text;
  const needle = check.caseInsensitive ? check.value.toLowerCase() : check.value;
  const found = haystack.includes(needle);
  return found
    ? pass(ctx, `response contains ${JSON.stringify(excerpt(check.value, 80))}`, {
        score: 1,
        details: { value: check.value },
      })
    : fail(ctx, `response does not contain ${JSON.stringify(excerpt(check.value, 80))}`, {
        score: 0,
        details: { value: check.value },
      });
};

export const notContainsGrader: Grader = (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'not_contains' }>;
  const haystack = check.caseInsensitive ? ctx.text.toLowerCase() : ctx.text;
  const needle = check.caseInsensitive ? check.value.toLowerCase() : check.value;
  const found = haystack.includes(needle);
  return found
    ? fail(ctx, `response contains forbidden text ${JSON.stringify(excerpt(check.value, 80))}`, {
        score: 0,
        details: { value: check.value },
      })
    : pass(ctx, `response does not contain ${JSON.stringify(excerpt(check.value, 80))}`, {
        score: 1,
        details: { value: check.value },
      });
};

export const regexGrader: Grader = (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'regex' }>;
  let pattern: RegExp;
  try {
    pattern = new RegExp(check.pattern, check.flags ?? '');
  } catch (err) {
    return fail(ctx, `invalid regular expression: ${(err as Error).message}`, {
      error: (err as Error).message,
    });
  }
  const match = pattern.exec(ctx.text);
  if (match) {
    return pass(ctx, `pattern ${check.pattern} matched`, {
      score: 1,
      details: { match: excerpt(match[0], 200), index: match.index },
    });
  }
  return fail(ctx, `pattern ${check.pattern} did not match`, {
    score: 0,
    details: { pattern: check.pattern },
  });
};

export const exactGrader: Grader = (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'exact' }>;
  const normalizers = check.normalize ?? ['trim'];
  const actual = applyNormalizers(ctx.text, normalizers);
  const expected = applyNormalizers(check.value, normalizers);
  const equal = actual === expected;
  return equal
    ? pass(ctx, `response matches the expected text`, {
        score: 1,
        details: { normalized: actual },
      })
    : fail(ctx, `response does not match the expected text`, {
        score: 0,
        details: { expected: excerpt(expected, 200), actual: excerpt(actual, 200) },
      });
};

export const lengthGrader: Grader = (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'length' }>;
  const unit = check.unit ?? 'chars';
  const value = unit === 'words' ? countWords(ctx.text) : countChars(ctx.text);
  const problems: string[] = [];
  if (check.min !== undefined && value < check.min) {
    problems.push(`length ${value} ${unit} is below the minimum of ${check.min}`);
  }
  if (check.max !== undefined && value > check.max) {
    problems.push(`length ${value} ${unit} is above the maximum of ${check.max}`);
  }
  const details = { value, unit, min: check.min, max: check.max };
  if (problems.length === 0) {
    return pass(ctx, `length ${value} ${unit} is within the allowed range`, {
      score: 1,
      details,
    });
  }
  return fail(ctx, problems.join('; '), { score: 0, details });
};
