import { compareRuns } from '../compare/compare.js';
import type { CaseResult, ComparisonResult, RunResult } from '../types.js';
import { mean, percentile } from '../utils/stats.js';
import { formatCost } from './console.js';

export interface VariantColumn {
  variant: string;
  run: RunResult;
  passRate: number;
  latencyP95: number;
  tokensPerAttempt?: number;
  costPerAttempt?: number;
  /** Comparison with the first variant (absent for the first one). */
  comparison?: ComparisonResult;
}

export interface VariantComparison {
  suiteName: string;
  caseIds: string[];
  columns: VariantColumn[];
}

/** Compares runs of the same suite against different targets; the first run is the baseline. */
export function compareVariants(runs: RunResult[], options: { significance?: number } = {}): VariantComparison {
  const caseIds: string[] = [];
  for (const run of runs) {
    for (const caseResult of run.cases) {
      if (!caseIds.includes(caseResult.id)) caseIds.push(caseResult.id);
    }
  }
  const columns = runs.map((run, index): VariantColumn => {
    const attempts = run.cases.flatMap((c) => c.attempts);
    const tokens = attempts.map((a) => a.usage?.totalTokens).filter((v): v is number => v !== undefined);
    const costs = attempts.map((a) => a.usage?.cost).filter((v): v is number => v !== undefined);
    return {
      variant: run.meta.variant ?? `run ${index + 1}`,
      run,
      passRate: run.totals.passRate,
      latencyP95: percentile(attempts.map((a) => a.latencyMs), 95),
      ...(tokens.length > 0 ? { tokensPerAttempt: mean(tokens) } : {}),
      ...(costs.length > 0 ? { costPerAttempt: mean(costs) } : {}),
      ...(index > 0 ? { comparison: compareRuns(runs[0]!, run, options) } : {}),
    };
  });
  return { suiteName: runs[0]?.meta.suiteName ?? '', caseIds, columns };
}

function caseCell(caseResult: CaseResult | undefined): string {
  if (!caseResult) return '—';
  const repeats = caseResult.repeat > 1 ? ` ${Math.round(caseResult.passRate * caseResult.repeat)}/${caseResult.repeat}` : '';
  switch (caseResult.status) {
    case 'passed':
      return `✔${repeats}`;
    case 'failed':
      return `✗${repeats}`;
    case 'flaky':
      return `~${repeats}`;
    case 'skipped':
      return 'skipped';
    default:
      return 'error';
  }
}

function rows(comparison: VariantComparison): string[][] {
  const { columns } = comparison;
  const base = columns[0]!;
  const relative = (value: number | undefined, baseValue: number | undefined, format: (v: number) => string): string => {
    if (value === undefined) return '—';
    if (baseValue === undefined || baseValue === 0 || value === baseValue) return format(value);
    const pct = ((value - baseValue) / baseValue) * 100;
    return `${format(value)} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`;
  };
  const out: string[][] = comparison.caseIds.map((id) => [
    id,
    ...columns.map((column) => caseCell(column.run.cases.find((c) => c.id === id))),
  ]);
  out.push(['pass rate', ...columns.map((c) => `${(c.passRate * 100).toFixed(1)}%`)]);
  out.push(['latency p95', ...columns.map((c) => relative(c.latencyP95, base.latencyP95, (v) => `${Math.round(v)}ms`))]);
  if (columns.some((c) => c.tokensPerAttempt !== undefined)) {
    out.push([
      'tokens / attempt',
      ...columns.map((c) => relative(c.tokensPerAttempt, base.tokensPerAttempt, (v) => String(Math.round(v)))),
    ]);
  }
  if (columns.some((c) => c.costPerAttempt !== undefined)) {
    out.push(['cost / attempt', ...columns.map((c) => relative(c.costPerAttempt, base.costPerAttempt, formatCost))]);
  }
  return out;
}

function summaries(comparison: VariantComparison): string[] {
  const base = comparison.columns[0]!;
  return comparison.columns.slice(1).map((column) => {
    const result = column.comparison!;
    const list = (deltas: Array<{ id: string }>): string => (deltas.length > 0 ? ` (${deltas.map((d) => d.id).join(', ')})` : '');
    const parts = [
      `${result.regressions.length} worse${list(result.regressions)}`,
      `${result.fixes.length} better${list(result.fixes)}`,
      ...(result.noise ? [`${result.noise.length} within noise`] : []),
    ];
    return `${column.variant} vs ${base.variant}: ${parts.join(', ')}`;
  });
}

export function variantsToConsole(comparison: VariantComparison): string {
  const header = ['case', ...comparison.columns.map((c) => c.variant)];
  const body = rows(comparison);
  const widths = header.map((_, index) => Math.max(...[header, ...body].map((row) => row[index]!.length)));
  const format = (row: string[]): string => row.map((cell, index) => cell.padEnd(widths[index]!)).join('   ').trimEnd();
  const lines = [
    '',
    `A/B · ${comparison.suiteName}`,
    '─'.repeat(Math.min(80, widths.reduce((sum, w) => sum + w + 3, 0))),
    format(header),
    ...body.map(format),
    '',
    ...summaries(comparison),
    '',
  ];
  return lines.join('\n');
}

export function variantsToMarkdown(comparison: VariantComparison): string {
  const header = ['Case', ...comparison.columns.map((c) => c.variant)];
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|');
  const lines = [
    `### A/B · ${escape(comparison.suiteName)}`,
    '',
    `| ${header.map(escape).join(' | ')} |`,
    `| ${header.map((_, i) => (i === 0 ? '---' : ':---:')).join(' | ')} |`,
    ...rows(comparison).map((row) => `| ${row.map(escape).join(' | ')} |`),
    '',
    ...summaries(comparison).map((line) => `- ${line}`),
    '',
  ];
  return lines.join('\n');
}
