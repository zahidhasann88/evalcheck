import { Command } from 'commander';

import { loadSuite } from '../core/config/loader.js';
import { EXIT_OK } from '../core/errors.js';

export function registerValidateCommand(program: Command): Command {
  return program
    .command('validate')
    .description('Validate a suite file without calling the endpoint')
    .argument('<suite>', 'path to the suite file (YAML or JSON)')
    .option('--json', 'print the validation result as JSON')
    .action(async (suitePath: string, options: { json?: boolean }) => {
      const loaded = await loadSuite(suitePath);
      const { suite, hash } = loaded;
      const checkCount = suite.cases.reduce((sum, c) => sum + (c.checks?.length ?? 0), 0);
      const checkTypes = new Set<string>();
      for (const caseSpec of suite.cases) {
        for (const check of caseSpec.checks ?? []) checkTypes.add(check.type);
      }

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              valid: true,
              name: suite.name,
              suiteHash: hash,
              cases: suite.cases.length,
              checks: checkCount,
              checkTypes: [...checkTypes].sort(),
              target: {
                url: suite.target.url,
                method: suite.target.method,
                preset: suite.target.preset,
                stream: suite.target.response.stream,
                timeoutMs: suite.target.timeoutMs,
              },
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stdout.write(`✔ ${suitePath} is valid\n`);
        process.stdout.write(`  suite      ${suite.name}\n`);
        process.stdout.write(`  hash       ${hash}\n`);
        process.stdout.write(`  target     ${suite.target.method} ${suite.target.url}\n`);
        process.stdout.write(`  cases      ${suite.cases.length}\n`);
        process.stdout.write(`  checks     ${checkCount} (${[...checkTypes].sort().join(', ') || 'none'})\n`);
      }
      process.exitCode = EXIT_OK;
    });
}
