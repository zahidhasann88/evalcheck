import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { customGrader, loadCustomCheck, clearCustomCheckCache } from '../../src/core/graders/custom.js';
import { makeContext } from '../helpers/context.js';

const fixtures = path.resolve(import.meta.dirname, '../fixtures');

describe('custom checks', () => {
  it('runs a JavaScript module and uses the verdict', async () => {
    const result = await customGrader(
      makeContext({
        check: { type: 'custom', module: path.join(fixtures, 'custom-check.mjs') },
        text: 'What is the refund policy?',
        caseSpec: { id: 'refund' },
      }),
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toContain('response looks like a question');
  });

  it('reports a failing verdict', async () => {
    const result = await customGrader(
      makeContext({
        check: { type: 'custom', module: path.join(fixtures, 'custom-check.mjs') },
        text: 'ok',
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
  });

  it('supports a named export', async () => {
    const result = await customGrader(
      makeContext({
        check: {
          type: 'custom',
          module: path.join(fixtures, 'custom-check-named.mjs'),
          export: 'noShouting',
        },
        text: 'this is SHOUTING text',
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('SHOUTING');
  });

  it('transpiles a TypeScript module', async () => {
    const result = await customGrader(
      makeContext({
        check: { type: 'custom', module: path.join(fixtures, 'custom-check.ts') },
        text: 'a'.repeat(120),
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('120');
  });

  it('explains when the module does not export a function', async () => {
    clearCustomCheckCache();
    await expect(
      loadCustomCheck(path.join(fixtures, 'custom-check-named.mjs'), 'missingExport'),
    ).rejects.toThrow(/does not export a function/);
  });

  it('exposes the response metadata to the check', async () => {
    const module = path.join(fixtures, 'custom-check.mjs');
    const fn = await loadCustomCheck(module);
    const verdict = await fn(
      { text: 'hello?', json: { a: 1 }, status: 201, latencyMs: 42, attempt: {} as never },
      {
        case: { id: 'c' },
        suite: {} as never,
        attempt: {} as never,
        check: { type: 'custom', module },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      },
    );
    expect(verdict.pass).toBe(true);
  });
});
