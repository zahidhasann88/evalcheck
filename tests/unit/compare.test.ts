import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { compareRuns, parseThresholds } from '../../src/core/compare/compare.js';
import { parseRunFile } from '../../src/core/report/json.js';
import type { RunResult } from '../../src/core/types.js';

const fixtureDir = path.resolve(import.meta.dirname, '../fixtures');

async function fixture(name: string): Promise<RunResult> {
  return parseRunFile(await readFile(path.join(fixtureDir, name), 'utf8'));
}

describe('threshold parsing', () => {
  it('parses an absolute threshold', () => {
    const [threshold] = parseThresholds(['pass_rate=-0.02']);
    expect(threshold).toMatchObject({ metric: 'pass_rate', value: -0.02, unit: 'absolute' });
  });

  it('parses a percentage threshold', () => {
    const [threshold] = parseThresholds(['latency_p95=+20%']);
    expect(threshold).toMatchObject({ metric: 'latency_p95', value: 0.2, unit: 'percent' });
  });

  it('parses a millisecond threshold', () => {
    const [threshold] = parseThresholds(['latency_p50=+150ms']);
    expect(threshold).toMatchObject({ metric: 'latency_p50', value: 150, unit: 'absolute' });
  });

  it('rejects unknown metrics', () => {
    expect(() => parseThresholds(['quality=0.5'])).toThrow(/Unknown threshold metric/);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseThresholds(['pass_rate'])).toThrow(/Expected the form/);
  });

  it('rejects non numeric values', () => {
    expect(() => parseThresholds(['pass_rate=abc'])).toThrow(/Expected a number/);
  });
});

describe('comparison', () => {
  it('detects regressions and fixes', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b);

    expect(comparison.regressions.map((d) => d.id)).toEqual(['refund-policy']);
    expect(comparison.fixes.map((d) => d.id)).toEqual(['shipping']);
    expect(comparison.newCases.map((d) => d.id)).toEqual(['new-case']);
    expect(comparison.removedCases).toHaveLength(0);
  });

  it('computes the overall pass rate delta', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b);
    expect(comparison.passRateDelta).toBeCloseTo(0.6 - 0.75, 5);
  });

  it('computes per check type deltas', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b);
    const contains = comparison.checkTypeDeltas.find((d) => d.type === 'contains');
    expect(contains).toBeDefined();
    // run-a: 4 of 6 contains checks passed, run-b: 5 of 7.
    expect(contains!.aPassRate).toBeCloseTo(4 / 6, 3);
    expect(contains!.bPassRate).toBeCloseTo(5 / 7, 3);
    expect(contains!.delta).toBeCloseTo(5 / 7 - 4 / 6, 3);
    expect(comparison.checkTypeDeltas.map((d) => d.type)).toContain('similarity');
  });

  it('computes latency percentile deltas', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b);
    expect(comparison.latency.p95B).toBeGreaterThan(comparison.latency.p95A);
    expect(comparison.latency.p95DeltaPct).toBeGreaterThan(0);
  });

  it('reports similarity drift per case', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b);
    const drift = comparison.similarityDrift.find((d) => d.id === 'similar-case');
    expect(drift).toBeDefined();
    expect(drift!.delta).toBeCloseTo(0.6 - 0.9, 5);
  });

  it('applies a percentage similarity threshold to the relative change', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    // 0.9 -> 0.6 is an absolute drop of 0.3 but a relative drop of 33%.
    const strict = compareRuns(a, b, { thresholds: parseThresholds(['similarity=-31%']) });
    expect(strict.violations.map((v) => v.metric)).toEqual(['similarity']);
    const loose = compareRuns(a, b, { thresholds: parseThresholds(['similarity=-35%']) });
    expect(loose.violations).toHaveLength(0);
  });

  it('flags a suite change', async () => {
    const a = await fixture('run-a.json');
    const c = await fixture('run-c-other-suite.json');
    const comparison = compareRuns(a, c);
    expect(comparison.suiteChanged).toBe(true);
  });

  it('reports no violations when the thresholds are respected', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b, { thresholds: parseThresholds(['pass_rate=-0.5', 'latency_p95=+500%']) });
    expect(comparison.violations).toHaveLength(0);
    // A case level regression is still reported, it is just within the thresholds.
    expect(comparison.regressions).toHaveLength(1);
  });

  it('violates the pass rate threshold', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b, { thresholds: parseThresholds(['pass_rate=-0.02']) });
    expect(comparison.violations).toHaveLength(1);
    expect(comparison.violations[0]!.metric).toBe('pass_rate');
    expect(comparison.hasRegressions).toBe(true);
  });

  it('violates the latency threshold', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b, { thresholds: parseThresholds(['latency_p95=+10%']) });
    expect(comparison.violations.map((v) => v.metric)).toContain('latency_p95');
  });

  it('does not violate a latency threshold that is not exceeded', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b, { thresholds: parseThresholds(['latency_p95=+500%']) });
    expect(comparison.violations).toHaveLength(0);
  });

  it('treats a case that becomes flaky as flaky, not as a regression', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    const comparison = compareRuns(a, b);
    expect(comparison.regressions.map((d) => d.id)).not.toContain('greeting');
  });
});
