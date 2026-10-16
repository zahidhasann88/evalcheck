import { jsonPathQuery, parseJsonPath } from '../utils/jsonpath.js';
import { canonicalJson } from '../utils/hash.js';
import type { GradeContext, Grader } from '../types.js';
import { excerpt, fail, pass } from './helpers.js';

export const jsonPathGrader: Grader = (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'json_path' }>;

  const document = resolveDocument(ctx);
  if (document === undefined) {
    return fail(ctx, 'response is not valid JSON, cannot evaluate a JSONPath', {
      score: 0,
      error: 'invalid-json',
    });
  }

  let matches: unknown[];
  try {
    parseJsonPath(check.path);
    matches = jsonPathQuery(document, check.path);
  } catch (err) {
    return fail(ctx, `invalid JSONPath "${check.path}": ${(err as Error).message}`, {
      score: 0,
      error: (err as Error).message,
    });
  }

  const found = matches.length > 0;
  const value = found ? matches[0] : undefined;

  const operators: string[] = [];
  if (check.exists !== undefined) operators.push('exists');
  if (check.equals !== undefined) operators.push('equals');
  if (check.matches !== undefined) operators.push('matches');
  if (check.gte !== undefined) operators.push('gte');
  if (check.lte !== undefined) operators.push('lte');
  if (check.contains !== undefined) operators.push('contains');

  if (operators.length === 0) {
    return fail(ctx, 'json_path check needs one of: exists, equals, matches, gte, lte, contains', {
      score: 0,
    });
  }

  for (const operator of operators) {
    const verdict = evaluate(operator, check, value, found);
    if (!verdict.pass) {
      return fail(ctx, verdict.reason, {
        score: 0,
        details: { path: check.path, value: describe(value), found },
      });
    }
  }

  return pass(ctx, `json path ${check.path} satisfies ${operators.join(', ')}`, {
    score: 1,
    details: { path: check.path, value: describe(value) },
  });
};

/** Prefers the extracted JSON object, then the whole body object, then the extracted scalar. */
export function resolveDocument(ctx: GradeContext): unknown {
  if (isStructured(ctx.json)) return ctx.json;
  if (isStructured(ctx.bodyJson)) return ctx.bodyJson;
  if (ctx.json !== undefined) return ctx.json;
  return ctx.bodyJson;
}

function isStructured(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function evaluate(
  operator: string,
  check: Extract<GradeContext['check'], { type: 'json_path' }>,
  value: unknown,
  found: boolean,
): { pass: boolean; reason: string } {
  switch (operator) {
    case 'exists': {
      const expected = check.exists === true;
      return found === expected
        ? { pass: true, reason: '' }
        : {
            pass: false,
            reason: `path ${check.path} ${found ? 'exists' : 'does not exist'} but ${expected ? 'should' : 'should not'} exist`,
          };
    }
    case 'equals': {
      if (!found) return { pass: false, reason: `path ${check.path} was not found` };
      const equal = canonicalJson(value) === canonicalJson(check.equals);
      return equal
        ? { pass: true, reason: '' }
        : {
            pass: false,
            reason: `path ${check.path} is ${describe(value)} but expected ${describe(check.equals)}`,
          };
    }
    case 'matches': {
      if (!found) return { pass: false, reason: `path ${check.path} was not found` };
      let pattern: RegExp;
      try {
        pattern = new RegExp(check.matches!);
      } catch (err) {
        return { pass: false, reason: `invalid regular expression: ${(err as Error).message}` };
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
      return pattern.test(text)
        ? { pass: true, reason: '' }
        : { pass: false, reason: `path ${check.path} does not match /${check.matches}/` };
    }
    case 'gte': {
      if (!found) return { pass: false, reason: `path ${check.path} was not found` };
      const numeric = toNumber(value);
      if (numeric === undefined) {
        return { pass: false, reason: `path ${check.path} is not numeric (${describe(value)})` };
      }
      return numeric >= check.gte!
        ? { pass: true, reason: '' }
        : { pass: false, reason: `path ${check.path} is ${numeric} but should be >= ${check.gte}` };
    }
    case 'lte': {
      if (!found) return { pass: false, reason: `path ${check.path} was not found` };
      const numeric = toNumber(value);
      if (numeric === undefined) {
        return { pass: false, reason: `path ${check.path} is not numeric (${describe(value)})` };
      }
      return numeric <= check.lte!
        ? { pass: true, reason: '' }
        : { pass: false, reason: `path ${check.path} is ${numeric} but should be <= ${check.lte}` };
    }
    case 'contains': {
      if (!found) return { pass: false, reason: `path ${check.path} was not found` };
      if (Array.isArray(value)) {
        const has = value.some((item) => canonicalJson(item) === canonicalJson(check.contains));
        return has
          ? { pass: true, reason: '' }
          : { pass: false, reason: `path ${check.path} does not contain ${describe(check.contains)}` };
      }
      if (typeof value === 'string') {
        const expected = typeof check.contains === 'string' ? check.contains : JSON.stringify(check.contains);
        return value.includes(expected)
          ? { pass: true, reason: '' }
          : { pass: false, reason: `path ${check.path} does not contain ${describe(check.contains)}` };
      }
      return { pass: false, reason: `path ${check.path} is not an array or string` };
    }
    default:
      return { pass: false, reason: `unsupported operator ${operator}` };
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return excerpt(value, 120);
  try {
    return excerpt(JSON.stringify(value), 120);
  } catch {
    return String(value);
  }
}
