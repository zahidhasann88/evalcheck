import { Command } from 'commander';

import { listBaselines, loadBaseline, saveBaseline, DEFAULT_BASELINE_DIR } from '../core/baseline.js';
import { reportToConsole } from '../core/report/console.js';
import { useColor } from './shared.js';

export function registerBaselineCommand(program: Command): Command {
  const baseline = program
    .command('baseline')
    .description('Manage baseline run files used for regression detection');

  baseline
    .command('save')
    .description('Store a run file as the baseline')
    .argument('<runFile>', 'run file (JSON) to use as the baseline')
    .option('--dir <dir>', 'directory that stores the baseline', DEFAULT_BASELINE_DIR)
    .option('--name <name>', 'name of the baseline', 'baseline')
    .action(async (runFile: string, options: { dir?: string; name?: string }) => {
      const saved = await saveBaseline(runFile, {
        ...(options.dir ? { dir: options.dir } : {}),
        ...(options.name ? { name: options.name } : {}),
      });
      process.stdout.write(`baseline saved: ${saved.path}\n`);
      process.stdout.write(
        `  suite ${saved.run.meta.suiteName}  run ${saved.run.meta.runId}  cases ${saved.run.totals.cases}  pass rate ${(saved.run.totals.passRate * 100).toFixed(1)}%\n`,
      );
    });

  baseline
    .command('show')
    .description('Show the summary of a stored baseline')
    .argument('[name]', 'baseline name (default: "baseline")')
    .option('--dir <dir>', 'directory that stores the baseline', DEFAULT_BASELINE_DIR)
    .option('--no-color', 'disable ANSI colors')
    .action(async (name: string | undefined, options: { dir?: string; color?: boolean }) => {
      const run = await loadBaseline(name ?? 'baseline', options.dir ?? DEFAULT_BASELINE_DIR);
      process.stdout.write(reportToConsole(run, { color: useColor(options) }));
    });

  baseline
    .command('list')
    .description('List the stored baselines')
    .option('--dir <dir>', 'directory that stores the baseline', DEFAULT_BASELINE_DIR)
    .action(async (options: { dir?: string }) => {
      const baselines = await listBaselines(options.dir ?? DEFAULT_BASELINE_DIR);
      if (baselines.length === 0) {
        process.stdout.write(`no baselines found in ${options.dir ?? DEFAULT_BASELINE_DIR}\n`);
        return;
      }
      for (const info of baselines) {
        process.stdout.write(`${info.name.padEnd(20)} ${info.modifiedAt}  ${info.size} bytes  ${info.path}\n`);
      }
    });

  return baseline;
}
