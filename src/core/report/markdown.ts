import type { CaseResult, ComparisonResult, RunResult } from '../types.js';
import { significanceLabel, underpoweredNote } from '../compare/compare.js';
import { percentile } from '../utils/stats.js';
import { formatCost, formatUsage, passRateDetail } from './console.js';

export interface MarkdownReporterOptions {
  /** Maximum number of failing cases shown in detail. */
  maxCases?: number;
  /** Maximum characters of each response shown. */
  maxResponseChars?: number;
}

export function markdownMarker(suiteName: string): string {
  return `<!-- evalcheck:${suiteName.replace(/[^A-Za-z0-9._-]+/g, '-')} -->`;
}

export function reportToMarkdown(result: RunResult, options: MarkdownReporterOptions = {}): string {
  const maxCases = options.maxCases ?? 20;
  const maxResponseChars = options.maxResponseChars ?? 500;
  const { totals, meta, comparison } = result;
  const failing = result.cases.filter((c) => c.status === 'failed' || c.status === 'error');
  const flaky = result.cases.filter((c) => c.status === 'flaky');
  const ok = failing.length === 0 && flaky.length === 0 && (!comparison || isCleanComparison(comparison));

  const lines: string[] = [];
  const title = meta.variant ? `${meta.suiteName} (${meta.variant})` : meta.suiteName;
  lines.push(markdownMarker(meta.variant ? `${meta.suiteName}-${meta.variant}` : meta.suiteName));
  lines.push(`### ${ok ? '✅' : '❌'} evalcheck · ${escapeText(title)}`);
  lines.push('');
  if (meta.replayed) {
    lines.push('_Graded from a recording, the endpoint was not called._');
    lines.push('');
  }

  const latencies = result.cases.flatMap((c) => c.attempts.map((a) => a.latencyMs));
  lines.push('| Cases | Passed | Failed | Flaky | Skipped | Pass rate | Latency p95 |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  lines.push(
    `| ${totals.cases} | ${totals.passed} | ${totals.failed + totals.errored} | ${totals.flaky} | ${totals.skipped} | ` +
      `${formatPct(totals.passRate)} | ${latencies.length > 0 ? formatMs(percentile(latencies, 95)) : 'n/a'} |`,
  );

  if (totals.usage) {
    lines.push('');
    lines.push(`Tokens: ${formatUsage(totals.usage).replace(/ {3}/g, ' · ')}`);
  }

  if (comparison) {
    lines.push('');
    lines.push(...renderComparison(comparison));
  }

  if (failing.length > 0) {
    lines.push('');
    lines.push(`#### Failing cases (${failing.length})`);
    lines.push('');
    for (const caseResult of failing.slice(0, maxCases)) {
      lines.push(...renderCase(caseResult, maxResponseChars));
    }
    if (failing.length > maxCases) {
      lines.push(`_…and ${failing.length - maxCases} more. See the full report in the run artifact._`);
      lines.push('');
    }
  }

  if (flaky.length > 0) {
    lines.push('');
    lines.push(`#### Flaky cases (${flaky.length})`);
    lines.push('');
    for (const caseResult of flaky.slice(0, maxCases)) {
      const passed = Math.round(caseResult.passRate * caseResult.repeat);
      lines.push(`- \`${caseResult.id}\`: ${passed}/${caseResult.repeat} repeats passed`);
    }
  }

  if (lines[lines.length - 1] !== '') lines.push('');
  const footer = [`run \`${meta.runId}\``];
  if (meta.git?.commit) footer.push(`commit \`${meta.git.commit.slice(0, 7)}\``);
  footer.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
  lines.push(`<sub>${footer.join(' · ')}</sub>`);
  lines.push('');
  return lines.join('\n');
}

function isCleanComparison(comparison: ComparisonResult): boolean {
  return comparison.regressions.length === 0 && comparison.violations.length === 0;
}

function renderComparison(comparison: ComparisonResult): string[] {
  const lines: string[] = [];
  const { latency } = comparison;
  lines.push('#### Compared with the baseline');
  lines.push('');
  lines.push('| | Baseline | This run | Change |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(
    `| Pass rate | ${formatPct(comparison.a.totals.passRate)} | ${formatPct(comparison.b.totals.passRate)} | ` +
      `${formatSigned(comparison.passRateDelta * 100, 1)} pp |`,
  );
  lines.push(
    `| Latency p50 | ${formatMs(latency.p50A)} | ${formatMs(latency.p50B)} | ${formatSigned(latency.p50DeltaPct, 1)}% |`,
  );
  lines.push(
    `| Latency p95 | ${formatMs(latency.p95A)} | ${formatMs(latency.p95B)} | ${formatSigned(latency.p95DeltaPct, 1)}% |`,
  );
  if (comparison.usage) {
    const usage = comparison.usage;
    lines.push(
      `| Tokens per attempt | ${Math.round(usage.tokensA)} | ${Math.round(usage.tokensB)} | ${formatSigned(usage.tokensDeltaPct, 1)}% |`,
    );
    if (usage.costA !== undefined && usage.costB !== undefined && usage.costDeltaPct !== undefined) {
      lines.push(
        `| Cost per attempt | ${formatCost(usage.costA)} | ${formatCost(usage.costB)} | ${formatSigned(usage.costDeltaPct, 1)}% |`,
      );
    }
  }
  lines.push('');

  const summary = [
    `**${comparison.regressions.length}** ${plural(comparison.regressions.length, 'regression')}`,
    `**${comparison.fixes.length}** ${plural(comparison.fixes.length, 'fix', 'fixes')}`,
    `**${comparison.newCases.length}** new`,
    `**${comparison.removedCases.length}** removed`,
    ...(comparison.noise ? [`**${comparison.noise.length}** within noise`] : []),
  ];
  lines.push(summary.join(' · '));

  if (comparison.regressions.length > 0) {
    lines.push('');
    lines.push('Regressions:');
    for (const regression of comparison.regressions) {
      const checks = regression.failingChecks.length > 0 ? regression.failingChecks.join(', ') : 'status changed';
      lines.push(
        `- ❌ \`${regression.id}\` (${regression.a} → ${regression.b})${significanceLabel(regression)}: ${escapeText(checks)}`,
      );
    }
  }
  if (comparison.fixes.length > 0) {
    lines.push('');
    lines.push('Fixed:');
    for (const fix of comparison.fixes) {
      lines.push(`- ✅ \`${fix.id}\`${significanceLabel(fix)}`);
    }
  }
  const note = underpoweredNote(comparison);
  if (note) {
    lines.push('');
    lines.push(`_Note: ${escapeText(note)}._`);
  }
  if (comparison.violations.length > 0) {
    lines.push('');
    lines.push('Threshold violations:');
    for (const violation of comparison.violations) {
      lines.push(`- ⚠️ ${escapeText(violation.message)}`);
    }
  }
  if (comparison.suiteChanged) {
    lines.push('');
    lines.push('_The suite file changed since the baseline was recorded._');
  }
  return lines;
}

function renderCase(caseResult: CaseResult, maxResponseChars: number): string[] {
  const failedChecks = caseResult.checks.filter((check) => check.passRate < 1 && check.optional !== true);
  const lines: string[] = [];
  lines.push('<details>');
  lines.push(
    `<summary><code>${escapeHtml(caseResult.id)}</code> · ${failedChecks.length} failing ${plural(failedChecks.length, 'check')}</summary>`,
  );
  lines.push('');
  if (caseResult.minPassRate !== undefined) {
    lines.push(`- ${passRateDetail(caseResult)}`);
  }
  for (const check of failedChecks) {
    const reason = check.reasons[0] ?? 'failed';
    lines.push(`- **${escapeText(check.id)}** (${check.type}): ${escapeText(reason)}`);
  }
  if (caseResult.error) {
    lines.push(`- request error: ${escapeText(caseResult.error)}`);
  }
  const attempt = caseResult.attempts.find((a) => a.checks.some((c) => !c.pass)) ?? caseResult.attempts[0];
  if (attempt) {
    lines.push('');
    if (attempt.turns) {
      for (const turn of attempt.turns) {
        lines.push(`Turn ${turn.index + 1}: ${escapeText(truncate(turn.input, 200))}`);
        lines.push(...fence(truncate(turn.text, maxResponseChars)));
      }
    } else {
      lines.push('Response:');
      lines.push(...fence(truncate(attempt.text, maxResponseChars)));
    }
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');
  return lines;
}

function fence(text: string): string[] {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = '`'.repeat(longest + 1);
  return [`${marks}text`, text || '(empty response)', marks];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, (ch) => `\\${ch}`).replace(/\s+/g, ' ');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return count === 1 ? word : pluralWord;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number): string {
  return `${Math.round(value)}ms`;
}

function formatSigned(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}
