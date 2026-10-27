import { Command } from 'commander';

import { allCaseChecks, loadSuite, type LoadedSuite } from '../core/config/loader.js';
import { expandSuitePaths } from '../core/config/shared.js';
import { EXIT_OK } from '../core/errors.js';

export function registerValidateCommand(program: Command): Command {
  return program
    .command('validate')
    .description('Validate suite files without calling the endpoint')
    .argument('<suites...>', 'suite files (YAML or JSON) or directories of suite files')
    .option('--config <file>', 'shared config file (default: evalcheck.config.yaml next to each suite)')
    .option('--json', 'print the validation result as JSON')
    .action(async (suitePaths: string[], options: { config?: string; json?: boolean }) => {
      const files = await expandSuitePaths(suitePaths);
      const summaries = [];
      for (const file of files) {
        const loaded = await loadSuite(file, options.config ? { config: options.config } : {});
        summaries.push({ file, loaded, ...summarize(loaded) });
      }

      if (options.json) {
        const results = summaries.map(({ loaded, checkCount, checkTypes }) => ({
          valid: true,
          name: loaded.suite.name,
          suiteHash: loaded.hash,
          ...(loaded.configPath ? { config: loaded.configPath } : {}),
          ...(loaded.suite.variants ? { variants: Object.keys(loaded.suite.variants) } : {}),
          cases: loaded.suite.cases.length,
          checks: checkCount,
          checkTypes,
          target: {
            url: loaded.suite.target.url,
            method: loaded.suite.target.method,
            preset: loaded.suite.target.preset,
            stream: loaded.suite.target.response.stream,
            timeoutMs: loaded.suite.target.timeoutMs,
          },
        }));
        process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
      } else {
        for (const { file, loaded, checkCount, checkTypes } of summaries) {
          const { suite, hash } = loaded;
          process.stdout.write(`✔ ${file} is valid\n`);
          process.stdout.write(`  suite      ${suite.name}\n`);
          process.stdout.write(`  hash       ${hash}\n`);
          if (loaded.configPath) process.stdout.write(`  config     ${loaded.configPath}\n`);
          if (suite.variants) process.stdout.write(`  variants   ${Object.keys(suite.variants).join(', ')}\n`);
          process.stdout.write(`  target     ${suite.target.method} ${suite.target.url}\n`);
          process.stdout.write(`  cases      ${suite.cases.length}\n`);
          process.stdout.write(`  checks     ${checkCount} (${checkTypes.join(', ') || 'none'})\n`);
        }
      }
      process.exitCode = EXIT_OK;
    });
}

function summarize(loaded: LoadedSuite): { checkCount: number; checkTypes: string[] } {
  const checks = loaded.suite.cases.flatMap((caseSpec) => allCaseChecks(caseSpec));
  return { checkCount: checks.length, checkTypes: [...new Set(checks.map((check) => check.type))].sort() };
}
