import type { CaseResult, CheckType, RunResult, TokenUsage } from '../types.js';
import { round } from '../utils/stats.js';

export interface ConsoleReporterOptions {
  color?: boolean;
  /** Hide the per-case failure details. */
  quiet?: boolean;
  /** Maximum number of failing cases listed. */
  maxFailures?: number;
  /** Optional sink for the rendered report. The report is always returned. */
  write?: (text: string) => void;
}

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  magenta: '[35m',
  cyan: '[36m',
  gray: '[90m',
};

export function reportToConsole(result: RunResult, options: ConsoleReporterOptions = {}): string {
  const color = options.color ?? false;
  const c = (code: string, text: string): string => (color ? `${code}${text}${ANSI.reset}` : text);
  const lines: string[] = [];

  const totals = result.totals;
  const rule = '─'.repeat(60);

  lines.push('');
  lines.push(
    c(ANSI.bold, `evalcheck · ${result.meta.suiteName}${result.meta.variant ? ` (${result.meta.variant})` : ''}`) +
      (result.meta.replayed ? c(ANSI.gray, '  (replayed from a recording)') : ''),
  );
  lines.push(c(ANSI.gray, rule));
  lines.push(
    `${c(ANSI.bold, 'cases')} ${totals.cases}   ` +
      `${c(ANSI.green, `passed ${totals.passed}`)}   ` +
      `${c(ANSI.red, `failed ${totals.failed}`)}   ` +
      `${c(ANSI.yellow, `flaky ${totals.flaky}`)}   ` +
      `${c(ANSI.gray, `skipped ${totals.skipped}`)}`,
  );
  lines.push(
    `${c(ANSI.bold, 'checks')} ${totals.checks}  ` +
      `${c(ANSI.green, `ok ${totals.checksPassed}`)}  ` +
      `${c(ANSI.red, `failed ${totals.checksFailed}`)}   ` +
      `${c(ANSI.gray, `requests ${totals.requests}`)}   ` +
      `${c(ANSI.gray, `duration ${(result.meta.durationMs / 1000).toFixed(2)}s`)}`,
  );
  lines.push(c(ANSI.gray, rule));

  // Flaky cases are called out separately: they are not the same as failures.
  if (totals.flaky > 0) {
    lines.push('');
    lines.push(c(ANSI.yellow, `⚠ ${totals.flaky} flaky case(s) - the outcome differed between repeats`));
    for (const caseResult of result.cases.filter((x) => x.status === 'flaky')) {
      lines.push(`  ${c(ANSI.yellow, '~')} ${caseResult.id}  ${flakyDetail(caseResult)}`);
    }
  }

  const byType = groupByCheckType(result.cases);
  if (byType.length > 0) {
    lines.push('');
    lines.push(c(ANSI.bold, 'per-check breakdown'));
    const width = Math.max(...byType.map((entry) => entry.type.length));
    for (const entry of byType) {
      const pct = entry.total === 0 ? 0 : (entry.passed / entry.total) * 100;
      const marker = entry.passed === entry.total ? c(ANSI.green, '✓') : c(ANSI.red, '✗');
      lines.push(
        `  ${marker} ${entry.type.padEnd(width)}  ${String(entry.passed).padStart(4)}/${String(entry.total).padEnd(4)} ` +
          `${c(ANSI.gray, `(${pct.toFixed(0)}%)`)}`,
      );
    }
  }

  const latencies = result.cases.flatMap((caseResult) => caseResult.attempts.map((a) => a.latencyMs));
  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = percentileOf(sorted, 50);
    const p95 = percentileOf(sorted, 95);
    const ttfts = result.cases
      .flatMap((caseResult) => caseResult.attempts.map((a) => a.ttftMs))
      .filter((v): v is number => v !== undefined);
    lines.push('');
    lines.push(
      `${c(ANSI.bold, 'latency')}  p50 ${Math.round(p50)}ms   p95 ${Math.round(p95)}ms   ` +
        `max ${Math.round(sorted[sorted.length - 1]!)}ms` +
        (ttfts.length > 0 ? `   ttft p50 ${Math.round(percentileOf(ttfts, 50))}ms` : ''),
    );

    const slowest = [...result.cases]
      .filter((caseResult) => caseResult.attempts.length > 0)
      .sort((a, b) => b.latencyMs.p95 - a.latencyMs.p95)
      .slice(0, 5);
    if (slowest.length > 0 && slowest[0]!.latencyMs.p95 > 0) {
      lines.push(c(ANSI.bold, 'slowest cases'));
      for (const caseResult of slowest) {
        lines.push(
          `  ${caseResult.id.padEnd(28)} ${String(Math.round(caseResult.latencyMs.p95)).padStart(6)}ms p95` +
            (caseResult.ttftMs !== undefined ? c(ANSI.gray, `  (ttft ${Math.round(caseResult.ttftMs)}ms)`) : ''),
        );
      }
    }
  }

  if (totals.usage) {
    lines.push('');
    lines.push(`${c(ANSI.bold, 'tokens')}   ${formatUsage(totals.usage)}`);
  }

  const failing = result.cases.filter((caseResult) => caseResult.status === 'failed' || caseResult.status === 'error');
  if (failing.length > 0 && !options.quiet) {
    lines.push('');
    lines.push(c(ANSI.red, `✗ ${failing.length} failing case(s)`));
    const max = options.maxFailures ?? 10;
    for (const caseResult of failing.slice(0, max)) {
      lines.push(`  ${c(ANSI.red, '✗')} ${c(ANSI.bold, caseResult.id)}`);
      if (caseResult.minPassRate !== undefined) {
        lines.push(`      ${c(ANSI.gray, passRateDetail(caseResult))}`);
      }
      for (const check of caseResult.checks.filter((x) => x.passRate < 1)) {
        const count = check.total - check.passCount;
        lines.push(
          `      ${c(ANSI.red, '·')} ${check.id} (${check.type}) failed ${count}/${check.total}: ${check.reasons[0] ?? 'unknown reason'}`,
        );
      }
      if (caseResult.error) {
        lines.push(`      ${c(ANSI.gray, `request error: ${caseResult.error}`)}`);
      }
    }
    if (failing.length > max) {
      lines.push(c(ANSI.gray, `  … and ${failing.length - max} more`));
    }
  }

  const reasons = topReasons(result.cases);
  if (reasons.length > 0) {
    lines.push('');
    lines.push(c(ANSI.bold, 'top failing reasons'));
    for (const entry of reasons) {
      lines.push(`  ${String(entry.count).padStart(3)}× ${entry.reason}`);
    }
  }

  lines.push('');
  const verdict =
    totals.failed === 0 && totals.flaky === 0 && totals.errored === 0
      ? c(ANSI.green, '✔ all checks passed')
      : c(ANSI.red, `✘ ${totals.failed} failing, ${totals.flaky} flaky`);
  lines.push(verdict);
  lines.push('');

  const text = lines.join('\n');
  options.write?.(text);
  return text;
}

export function formatUsage(usage: TokenUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens.toLocaleString('en-US')}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens.toLocaleString('en-US')}`);
  if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens.toLocaleString('en-US')}`);
  if (usage.cost !== undefined) parts.push(`cost ${formatCost(usage.cost)}`);
  return parts.join('   ');
}

export function formatCost(cost: number): string {
  return cost >= 1 ? cost.toFixed(2) : cost.toPrecision(3);
}

export function passRateDetail(caseResult: CaseResult): string {
  const passed = Math.round(caseResult.passRate * caseResult.repeat);
  const needed = Math.round((caseResult.minPassRate ?? 1) * 100);
  return `${passed}/${caseResult.repeat} repeats passed, at least ${needed}% required`;
}

function flakyDetail(caseResult: CaseResult): string {
  const passed = Math.round(caseResult.passRate * caseResult.repeat);
  return `${passed}/${caseResult.repeat} repeats passed`;
}

export function groupByCheckType(
  cases: CaseResult[],
): Array<{ type: CheckType; passed: number; total: number }> {
  const map = new Map<CheckType, { passed: number; total: number }>();
  for (const caseResult of cases) {
    for (const check of caseResult.checks) {
      const current = map.get(check.type) ?? { passed: 0, total: 0 };
      current.passed += check.passCount;
      current.total += check.total;
      map.set(check.type, current);
    }
  }
  return [...map.entries()]
    .map(([type, value]) => ({ type, ...value }))
    .sort((a, b) => b.total - a.total);
}

export function topReasons(cases: CaseResult[], limit = 5): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const caseResult of cases) {
    for (const check of caseResult.checks) {
      if (check.passRate >= 1) continue;
      for (const reason of check.reasons) {
        const key = normalizeReason(reason);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, limit);
}

function normalizeReason(reason: string): string {
  return reason
    .replace(/\d+ms/g, '<n>ms')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .slice(0, 160);
}

function percentileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! * (1 - (rank - low)) + sorted[high]! * (rank - low);
}

export { round };
