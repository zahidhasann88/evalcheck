import type {
  CaseDelta,
  CaseResult,
  CaseStatus,
  CheckType,
  CheckTypeDelta,
  ComparisonResult,
  RunResult,
  ThresholdSpec,
  ThresholdViolation,
} from '../types.js';
import { mean, percentile, round } from '../utils/stats.js';

export type MetricDirection = 'higher' | 'lower';

export interface MetricSpec {
  name: string;
  direction: MetricDirection;
  unit: 'ratio' | 'ms' | 'score';
  description: string;
}

export const METRICS: Record<string, MetricSpec> = {
  pass_rate: {
    name: 'pass_rate',
    direction: 'higher',
    unit: 'ratio',
    description: 'overall pass rate of the run (0..1)',
  },
  latency_p50: {
    name: 'latency_p50',
    direction: 'lower',
    unit: 'ms',
    description: 'median request latency in milliseconds',
  },
  latency_p95: {
    name: 'latency_p95',
    direction: 'lower',
    unit: 'ms',
    description: '95th percentile request latency in milliseconds',
  },
  similarity: {
    name: 'similarity',
    direction: 'higher',
    unit: 'score',
    description: 'mean similarity score of the similarity checks',
  },
};

/**
 * Parses threshold expressions such as `pass_rate=-0.02` or
 * `latency_p95=+20%`.
 */
export function parseThresholds(specs: string[] = []): ThresholdSpec[] {
  const out: ThresholdSpec[] = [];
  for (const raw of specs) {
    const index = raw.indexOf('=');
    if (index === -1) {
      throw new Error(
        `Invalid threshold "${raw}". Expected the form metric=value, e.g. "pass_rate=-0.02" or "latency_p95=+20%".`,
      );
    }
    const metric = raw.slice(0, index).trim();
    const rawValue = raw.slice(index + 1).trim();

    if (!METRICS[metric]) {
      const known = Object.keys(METRICS).join(', ');
      throw new Error(`Unknown threshold metric "${metric}". Known metrics: ${known}.`);
    }

    let unit: 'absolute' | 'percent' = 'absolute';
    let valueText = rawValue;
    if (rawValue.endsWith('%')) {
      unit = 'percent';
      valueText = rawValue.slice(0, -1).trim();
    } else if (rawValue.toLowerCase().endsWith('ms')) {
      valueText = rawValue.slice(0, -2).trim();
    }

    const parsed = Number(valueText);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid threshold value "${rawValue}" in "${raw}". Expected a number.`);
    }

    const value = unit === 'percent' ? parsed / 100 : parsed;
    out.push({ raw, metric, value, unit });
  }
  return out;
}

export interface CompareOptions {
  thresholds?: ThresholdSpec[];
}

export function compareRuns(a: RunResult, b: RunResult, options: CompareOptions = {}): ComparisonResult {
  const thresholds = options.thresholds ?? [];

  const casesA = new Map(a.cases.map((c) => [c.id, c]));
  const casesB = new Map(b.cases.map((c) => [c.id, c]));

  const regressions: CaseDelta[] = [];
  const fixes: CaseDelta[] = [];
  const flaky: CaseDelta[] = [];
  const newCases: CaseDelta[] = [];
  const removedCases: CaseDelta[] = [];
  const similarityDrift: Array<{ id: string; a: number; b: number; delta: number }> = [];

  for (const [id, caseB] of casesB) {
    const caseA = casesA.get(id);
    if (!caseA) {
      newCases.push(makeDelta(id, 'new', caseB, undefined));
      continue;
    }

    const delta = makeDelta(id, classify(caseA, caseB), caseB, caseA);

    if (delta.kind === 'regression') regressions.push(delta);
    else if (delta.kind === 'fix') fixes.push(delta);
    else if (delta.kind === 'flaky') flaky.push(delta);

    const simA = similarityScore(caseA);
    const simB = similarityScore(caseB);
    if (simA !== undefined && simB !== undefined) {
      similarityDrift.push({
        id,
        a: round(simA, 4),
        b: round(simB, 4),
        delta: round(simB - simA, 4),
      });
    }
  }

  for (const [id, caseA] of casesA) {
    if (!casesB.has(id)) {
      removedCases.push(makeDelta(id, 'removed', undefined, caseA));
    }
  }

  const checkTypeDeltas = computeCheckTypeDeltas(a, b);

  const latenciesA = collectLatencies(a);
  const latenciesB = collectLatencies(b);
  const p50A = round(percentile(latenciesA, 50), 2);
  const p50B = round(percentile(latenciesB, 50), 2);
  const p95A = round(percentile(latenciesA, 95), 2);
  const p95B = round(percentile(latenciesB, 95), 2);

  const passRateDelta = round(b.totals.passRate - a.totals.passRate, 4);
  const simMeanA = mean(similarityDrift.map((d) => d.a));
  const simMeanB = mean(similarityDrift.map((d) => d.b));

  const metrics: Record<string, { delta: number; relative: number; valueA: number; valueB: number }> = {
    pass_rate: {
      delta: passRateDelta,
      relative: passRateDelta,
      valueA: a.totals.passRate,
      valueB: b.totals.passRate,
    },
    latency_p50: {
      delta: round(p50B - p50A, 2),
      relative: p50A === 0 ? 0 : round((p50B - p50A) / p50A, 4),
      valueA: p50A,
      valueB: p50B,
    },
    latency_p95: {
      delta: round(p95B - p95A, 2),
      relative: p95A === 0 ? 0 : round((p95B - p95A) / p95A, 4),
      valueA: p95A,
      valueB: p95B,
    },
    similarity: {
      delta: round(simMeanB - simMeanA, 4),
      relative: simMeanA === 0 ? 0 : round((simMeanB - simMeanA) / Math.abs(simMeanA), 4),
      valueA: round(simMeanA, 4),
      valueB: round(simMeanB, 4),
    },
  };

  const violations: ThresholdViolation[] = [];
  for (const threshold of thresholds) {
    const metric = METRICS[threshold.metric]!;
    const observed = metrics[threshold.metric];
    if (!observed) continue;

    // Percentage thresholds compare the relative change, absolute ones the raw delta.
    const change = threshold.unit === 'percent' ? observed.relative : observed.delta;
    const worse = metric.direction === 'higher' ? change < threshold.value : change > threshold.value;

    if (worse) {
      violations.push({
        metric: threshold.metric,
        delta: observed.delta,
        threshold,
        direction: 'worse',
        message: describeViolation(threshold, observed, metric),
      });
    }
  }

  return {
    a: {
      runId: a.meta.runId,
      suiteHash: a.meta.suiteHash,
      finishedAt: a.meta.finishedAt,
      totals: a.totals,
    },
    b: {
      runId: b.meta.runId,
      suiteHash: b.meta.suiteHash,
      finishedAt: b.meta.finishedAt,
      totals: b.totals,
    },
    passRateDelta,
    checkTypeDeltas,
    latency: {
      p50A,
      p50B,
      p50DeltaMs: round(p50B - p50A, 2),
      p50DeltaPct: p50A === 0 ? 0 : round(((p50B - p50A) / p50A) * 100, 2),
      p95A,
      p95B,
      p95DeltaMs: round(p95B - p95A, 2),
      p95DeltaPct: p95A === 0 ? 0 : round(((p95B - p95A) / p95A) * 100, 2),
    },
    regressions,
    fixes,
    flaky,
    newCases,
    removedCases,
    similarityDrift,
    thresholds,
    violations,
    hasRegressions: regressions.length > 0 || violations.length > 0,
    suiteChanged: a.meta.suiteHash !== b.meta.suiteHash,
  };
}

function classify(a: CaseResult, b: CaseResult): CaseDelta['kind'] {
  if (a.status === 'passed' && (b.status === 'failed' || b.status === 'error')) return 'regression';
  if (a.status === 'failed' && b.status === 'passed') return 'fix';
  if (a.status === 'passed' && b.status === 'flaky') return 'flaky';
  if (a.status === 'flaky' && b.status === 'passed') return 'fix';
  if (a.status === 'passed') return 'unchanged-pass';
  return 'unchanged-fail';
}

function makeDelta(
  id: string,
  kind: CaseDelta['kind'],
  b: CaseResult | undefined,
  a: CaseResult | undefined,
): CaseDelta {
  const passRateDelta = b && a ? round(b.passRate - a.passRate, 4) : 0;
  const p95B = b?.latencyMs.p95 ?? 0;
  const p95A = a?.latencyMs.p95 ?? 0;
  const failingChecks = b
    ? b.checks.filter((c) => c.passRate < 1).map((c) => `${c.id} (${c.type})`)
    : [];
  const simA = a ? similarityScore(a) : undefined;
  const simB = b ? similarityScore(b) : undefined;

  const delta: CaseDelta = {
    id,
    a: (a?.status ?? 'new') as CaseStatus,
    b: (b?.status ?? 'removed') as CaseStatus,
    kind,
    passRateDelta,
    latencyP95DeltaMs: round(p95B - p95A, 2),
    latencyP95DeltaPct: p95A === 0 ? 0 : round(((p95B - p95A) / p95A) * 100, 2),
    failingChecks,
  };
  if (simA !== undefined && simB !== undefined) {
    delta.similarityDelta = round(simB - simA, 4);
  }
  return delta;
}

function similarityScore(caseResult: CaseResult): number | undefined {
  const scores: number[] = [];
  for (const check of caseResult.checks) {
    if (check.type !== 'similarity') continue;
    scores.push(...check.scores);
  }
  if (scores.length === 0) return undefined;
  return mean(scores);
}

function collectLatencies(result: RunResult): number[] {
  const latencies: number[] = [];
  for (const caseResult of result.cases) {
    for (const attempt of caseResult.attempts) {
      latencies.push(attempt.latencyMs);
    }
  }
  return latencies;
}

function computeCheckTypeDeltas(a: RunResult, b: RunResult): CheckTypeDelta[] {
  const statsA = checkTypeStats(a);
  const statsB = checkTypeStats(b);
  const types = new Set<CheckType>([...statsA.keys(), ...statsB.keys()]);
  const deltas: CheckTypeDelta[] = [];
  for (const type of types) {
    const statA = statsA.get(type) ?? { passed: 0, total: 0 };
    const statB = statsB.get(type) ?? { passed: 0, total: 0 };
    const rateA = statA.total === 0 ? 0 : statA.passed / statA.total;
    const rateB = statB.total === 0 ? 0 : statB.passed / statB.total;
    deltas.push({
      type,
      aPassRate: round(rateA, 4),
      bPassRate: round(rateB, 4),
      delta: round(rateB - rateA, 4),
    });
  }
  return deltas.sort((x, y) => x.type.localeCompare(y.type));
}

function checkTypeStats(result: RunResult): Map<CheckType, { passed: number; total: number }> {
  const stats = new Map<CheckType, { passed: number; total: number }>();
  for (const caseResult of result.cases) {
    for (const check of caseResult.checks) {
      const current = stats.get(check.type) ?? { passed: 0, total: 0 };
      current.passed += check.passCount;
      current.total += check.total;
      stats.set(check.type, current);
    }
  }
  return stats;
}

function describeViolation(
  threshold: ThresholdSpec,
  observed: { delta: number; relative: number; valueA: number; valueB: number },
  metric: MetricSpec,
): string {
  const direction = metric.direction === 'higher' ? 'dropped' : 'increased';
  if (threshold.unit === 'percent') {
    return `${metric.name} ${direction} by ${(observed.relative * 100).toFixed(2)}% which exceeds the allowed ${(threshold.value * 100).toFixed(2)}%`;
  }
  return `${metric.name} ${direction} by ${observed.delta} which exceeds the allowed ${threshold.value}`;
}
