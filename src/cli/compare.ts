import { Command } from 'commander';

import { compareRuns, parseThresholds } from '../core/compare/compare.js';
import { parseRunFile } from '../core/report/json.js';
import { reportToJson } from '../core/report/json.js';
import { EXIT_CHECK_FAILED, EXIT_OK } from '../core/errors.js';
import { readFile } from 'node:fs/promises';

export interface CompareCommandOptions {
  failOnRegression?: boolean;
  threshold?: string[];
  format?: string;
}

export function registerCompareCommand(program: Command): Command {
  return program
    .command('compare')
    .description('Compare two run files and report regressions and fixes')
    .argument('<a>', 'baseline run file (JSON)')
    .argument('<b>', 'new run file (JSON)')
    .option('--fail-on-regression', 'exit with code 1 when a case regresses')
    .option('--threshold <spec>', 'threshold, e.g. pass_rate=-0.02 or latency_p95=+20%', collect, [])
    .option('--format <format>', 'console | json', 'console')
    .action(async (a: string, b: string, options: CompareCommandOptions) => {
      process.exitCode = await compareCommand(a, b, options);
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function compareCommand(
  aPath: string,
  bPath: string,
  options: CompareCommandOptions,
): Promise<number> {
  const a = parseRunFile(await readFile(aPath, 'utf8'));
  const b = parseRunFile(await readFile(bPath, 'utf8'));
  const thresholds = parseThresholds(options.threshold ?? []);
  const comparison = compareRuns(a, b, { thresholds });

  if ((options.format ?? 'console').toLowerCase() === 'json') {
    process.stdout.write(`${reportToJson({ ...b, comparison })}\n`);
  } else {
    printComparison(comparison, thresholds.map((t) => t.raw));
  }

  const hasViolations = comparison.violations.length > 0;
  const hasRegressions = comparison.regressions.length > 0;
  if (hasViolations || (options.failOnRegression && hasRegressions)) {
    return EXIT_CHECK_FAILED;
  }
  return EXIT_OK;
}

function printComparison(comparison: NonNullable<ReturnType<typeof compareRuns>>, thresholdLabels: string[]): void {
  const out = process.stdout;
  out.write('\n');
  out.write(`baseline  ${comparison.a.runId}  (${comparison.a.finishedAt})\n`);
  out.write(`current   ${comparison.b.runId}  (${comparison.b.finishedAt})\n`);
  if (comparison.suiteChanged) {
    out.write('\n⚠ the suite changed between the two runs (different suite hash)\n');
  }
  out.write('\n');
  out.write(
    `pass rate  ${(comparison.a.totals.passRate * 100).toFixed(2)}% → ${(comparison.b.totals.passRate * 100).toFixed(2)}%  (${comparison.passRateDelta >= 0 ? '+' : ''}${(comparison.passRateDelta * 100).toFixed(2)}pp)\n`,
  );
  out.write(
    `latency    p50 ${comparison.latency.p50A}ms → ${comparison.latency.p50B}ms (${comparison.latency.p50DeltaPct >= 0 ? '+' : ''}${comparison.latency.p50DeltaPct.toFixed(1)}%)   p95 ${comparison.latency.p95A}ms → ${comparison.latency.p95B}ms (${comparison.latency.p95DeltaPct >= 0 ? '+' : ''}${comparison.latency.p95DeltaPct.toFixed(1)}%)\n`,
  );
  out.write('\nper check type\n');
  for (const delta of comparison.checkTypeDeltas) {
    out.write(
      `  ${delta.type.padEnd(16)} ${(delta.aPassRate * 100).toFixed(1)}% → ${(delta.bPassRate * 100).toFixed(1)}%  (${delta.delta >= 0 ? '+' : ''}${(delta.delta * 100).toFixed(1)}pp)\n`,
    );
  }

  if (comparison.regressions.length > 0) {
    out.write(`\n✗ ${comparison.regressions.length} regression(s)\n`);
    for (const delta of comparison.regressions) {
      out.write(
        `  ${delta.id}: ${delta.a} → ${delta.b}${delta.failingChecks.length ? ` (${delta.failingChecks.join(', ')})` : ''}\n`,
      );
    }
  }
  if (comparison.fixes.length > 0) {
    out.write(`\n✔ ${comparison.fixes.length} fix(es)\n`);
    for (const delta of comparison.fixes) {
      out.write(`  ${delta.id}: ${delta.a} → ${delta.b}\n`);
    }
  }
  if (comparison.flaky.length > 0) {
    out.write(`\n⚠ ${comparison.flaky.length} case(s) became flaky\n`);
    for (const delta of comparison.flaky) {
      out.write(`  ${delta.id}: ${delta.a} → ${delta.b}\n`);
    }
  }
  if (comparison.newCases.length > 0) {
    out.write(`\n+ ${comparison.newCases.length} new case(s): ${comparison.newCases.map((d) => d.id).join(', ')}\n`);
  }
  if (comparison.removedCases.length > 0) {
    out.write(`\n- ${comparison.removedCases.length} removed case(s): ${comparison.removedCases.map((d) => d.id).join(', ')}\n`);
  }

  const drift = comparison.similarityDrift.filter((entry) => Math.abs(entry.delta) >= 0.01);
  if (drift.length > 0) {
    out.write('\nsimilarity drift\n');
    for (const entry of drift) {
      out.write(
        `  ${entry.id}: ${entry.a.toFixed(3)} → ${entry.b.toFixed(3)} (${entry.delta >= 0 ? '+' : ''}${entry.delta.toFixed(3)})\n`,
      );
    }
  }

  if (comparison.violations.length > 0) {
    out.write(`\n⚠ ${comparison.violations.length} threshold violation(s)\n`);
    for (const violation of comparison.violations) {
      out.write(`  ${violation.metric}: ${violation.message}\n`);
    }
  } else if (thresholdLabels.length > 0) {
    out.write(`\n✔ all thresholds respected (${thresholdLabels.join(', ')})\n`);
  }
  out.write('\n');
}
