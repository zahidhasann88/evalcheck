import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { compareRuns, parseSignificance, significanceLabel, underpoweredNote } from '../../src/core/compare/compare.js';
import { parseRunFile } from '../../src/core/report/json.js';
import { reportToMarkdown } from '../../src/core/report/markdown.js';
import type { CaseResult, RunResult } from '../../src/core/types.js';
import { fisherLowerTail, minimumPValue } from '../../src/core/utils/fisher.js';
import { makeAttempt } from '../helpers/context.js';

describe('Fisher exact test', () => {
  it('matches known values', () => {
    expect(fisherLowerTail(9, 1, 8, 2)).toBeCloseTo(0.5, 5);
    expect(fisherLowerTail(10, 0, 4, 6)).toBeCloseTo(0.005418, 5);
    expect(fisherLowerTail(5, 5, 5, 5)).toBeCloseTo(0.6719, 4);
    expect(fisherLowerTail(4, 6, 10, 0)).toBe(1);
  });

  it('knows how many repeats a case needs', () => {
    expect(minimumPValue(1, 1)).toBe(0.5);
    expect(minimumPValue(3, 3)).toBeCloseTo(0.05, 5);
    expect(minimumPValue(4, 4)).toBeCloseTo(1 / 70, 5);
  });
});

function caseWith(id: string, passed: number, total: number): CaseResult {
  const status = passed === total ? 'passed' : passed === 0 ? 'failed' : 'flaky';
  return {
    id,
    status,
    passRate: passed / total,
    repeat: total,
    tags: [],
    checks: [],
    attempts: Array.from({ length: total }, (_, index) => makeAttempt({ index })),
    latencyMs: { min: 10, max: 10, mean: 10, p50: 10, p95: 10 },
    durationMs: 10,
  };
}

async function runWith(cases: CaseResult[]): Promise<RunResult> {
  const fixture = path.resolve(import.meta.dirname, '../fixtures/run-a.json');
  const run = parseRunFile(await readFile(fixture, 'utf8'));
  return { ...run, cases };
}

describe('compare with a significance level', () => {
  it('separates real regressions from noise', async () => {
    const a = await runWith([caseWith('steady', 9, 10), caseWith('broken', 10, 10), caseWith('better', 3, 10)]);
    const b = await runWith([caseWith('steady', 8, 10), caseWith('broken', 4, 10), caseWith('better', 10, 10)]);

    const plain = compareRuns(a, b);
    expect(plain.noise).toBeUndefined();
    expect(plain.flaky.map((d) => d.id)).toEqual(['broken']);

    const tested = compareRuns(a, b, { significance: 0.05 });
    expect(tested.significance).toBe(0.05);
    expect(tested.regressions.map((d) => d.id)).toEqual(['broken']);
    expect(tested.regressions[0]!.pValue).toBeCloseTo(0.0054, 4);
    expect(tested.fixes.map((d) => d.id)).toEqual(['better']);
    expect(tested.noise!.map((d) => d.id)).toEqual(['steady']);
    expect(tested.underpowered).toEqual([]);
    expect(significanceLabel(tested.regressions[0]!)).toBe(' (-60pp, p=0.005)');
  });

  it('warns when cases have too few repeats', async () => {
    const a = await runWith([caseWith('single', 1, 1)]);
    const b = await runWith([caseWith('single', 0, 1)]);
    const tested = compareRuns(a, b, { significance: 0.05 });
    expect(tested.regressions).toEqual([]);
    expect(tested.noise!.map((d) => d.id)).toEqual(['single']);
    expect(underpoweredNote(tested)).toMatch(/^1 case\(s\) have too few repeats to reach p < 0.05/);

    b.comparison = tested;
    const markdown = reportToMarkdown(b);
    expect(markdown).toContain('**1** within noise');
    expect(markdown).toContain('too few repeats');
  });

  it('validates the level', () => {
    expect(parseSignificance('0.05')).toBe(0.05);
    expect(() => parseSignificance('5')).toThrow(/between 0 and 1/);
    expect(() => parseSignificance('0')).toThrow(/between 0 and 1/);
  });
});
