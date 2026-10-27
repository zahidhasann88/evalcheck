import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

import { allCaseChecks, parseSuiteSource } from '../../src/core/config/loader.js';
import { suiteJsonSchema } from '../../src/core/config/json-schema.js';
import { allOfGrader, anyOfGrader, notGrader } from '../../src/core/graders/combinators.js';
import type { Check, CheckResult } from '../../src/core/types.js';
import { makeContext } from '../helpers/context.js';

const contains = (value: string): Check => ({ type: 'contains', value });

async function grade(check: Check, text: string): Promise<CheckResult> {
  const grader = check.type === 'any_of' ? anyOfGrader : check.type === 'all_of' ? allOfGrader : notGrader;
  return grader(makeContext({ check, text }));
}

describe('any_of', () => {
  it('passes when one check passes', async () => {
    const result = await grade({ type: 'any_of', checks: [contains('30 days'), contains('one month')] }, 'within one month');
    expect(result.pass).toBe(true);
    expect(result.reason).toMatch(/^contains passed/);
  });

  it('lists every reason when none passes', async () => {
    const result = await grade(
      { type: 'any_of', checks: [{ ...contains('30 days'), id: 'thirty' }, { ...contains('one month'), id: 'month' }] },
      'no idea',
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/^none of the checks passed: thirty: .*; month: /);
    expect(result.details).toMatchObject({ checks: [{ id: 'thirty', pass: false }, { id: 'month', pass: false }] });
  });
});

describe('all_of', () => {
  it('passes only when every check passes', async () => {
    const check: Check = { type: 'all_of', checks: [contains('refund'), contains('30 days')] };
    expect((await grade(check, 'refund within 30 days')).pass).toBe(true);
    const failed = await grade(check, 'refund later');
    expect(failed.pass).toBe(false);
    expect(failed.reason).toMatch(/^contains: /);
  });
});

describe('not', () => {
  it('inverts a check', async () => {
    const check: Check = { type: 'not', check: { type: 'regex', pattern: 'guarantee', flags: 'i' } };
    expect((await grade(check, 'no promises')).pass).toBe(true);
    const failed = await grade(check, 'We GUARANTEE it');
    expect(failed.pass).toBe(false);
    expect(failed.reason).toMatch(/^expected regex to fail, but it passed/);
  });

  it('fails when the inner check cannot run', async () => {
    const result = await grade({ type: 'not', check: { type: 'json_path', path: '$[', exists: true } }, '{"a":1}');
    expect(result.pass).toBe(false);
  });
});

it('nests combinators', async () => {
  const check: Check = {
    type: 'any_of',
    checks: [
      { type: 'all_of', checks: [contains('refund'), { type: 'not', check: contains('never') }] },
      contains('contact support'),
    ],
  };
  expect((await grade(check, 'refund approved')).pass).toBe(true);
  expect((await grade(check, 'refund never')).pass).toBe(false);
  expect((await grade(check, 'please contact support')).pass).toBe(true);
});

describe('combinators in suites', () => {
  const source = `
name: x
target:
  url: http://x
cases:
  - id: a
    input: hi
    checks:
      - type: any_of
        checks:
          - type: contains
            value: "30 days"
          - type: not
            check:
              type: custom
              module: ./checks/a.mjs
`;

  it('resolves nested paths and exposes nested checks', () => {
    const { suite } = parseSuiteSource(source, '/tmp/project/suite.yaml');
    const types = allCaseChecks(suite.cases[0]!).map((c) => c.type);
    expect(types).toEqual(['any_of', 'contains', 'not', 'custom']);
    const custom = allCaseChecks(suite.cases[0]!).find((c) => c.type === 'custom')!;
    expect(custom.type === 'custom' && custom.module).toMatch(/project[\\/]checks[\\/]a\.mjs$/);
  });

  it('validates nested checks', () => {
    let details = '';
    try {
      parseSuiteSource(source.replace(/type: custom\n\s+module: \.\/checks\/a\.mjs/, 'type: lexical_overlap'), '/tmp/suite.yaml');
    } catch (err) {
      details = (err as { details: string[] }).details.join('\n');
    }
    expect(details).toContain('cases.0.checks.0.checks.1.check: lexical_overlap check requires "reference"');
    expect(() => parseSuiteSource(source.replace('type: any_of\n        checks:', 'type: any_of\n        checks: []\n        x:'), '/tmp/suite.yaml')).toThrow();
  });

  it('is described by the JSON Schema', () => {
    const validate = new Ajv({ strict: false }).compile(suiteJsonSchema());
    const suite = {
      name: 'x',
      target: { url: 'http://x' },
      cases: [{ id: 'a', checks: [{ type: 'any_of', checks: [{ type: 'not', check: { type: 'contains', value: 'x' } }] }] }],
    };
    expect(validate(suite)).toBe(true);
    suite.cases[0]!.checks[0]!.checks![0]!.check = { type: 'contains', valeu: 'x' } as never;
    expect(validate(suite)).toBe(false);
  });
});
