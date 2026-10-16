import { readFile } from 'node:fs/promises';

import { Command } from 'commander';

import { parseRunFile, reportToJson } from '../core/report/json.js';
import { reportToJunit } from '../core/report/junit.js';
import { reportToHtml } from '../core/report/html.js';
import { reportToConsole } from '../core/report/console.js';
import { writeArtifact } from './shared.js';

export function registerReportCommand(program: Command): Command {
  return program
    .command('report')
    .description('Generate a report from a stored run file')
    .argument('<runFile>', 'run file (JSON) produced by "evalcheck run"')
    .option('--format <format>', 'console | json | junit | html', 'html')
    .option('--out <file>', 'write the report to a file instead of stdout')
    .option('--baseline <file>', 'baseline run file used for the response diff')
    .option('--no-color', 'disable ANSI colors')
    .action(async (runFile: string, options: { format?: string; out?: string; baseline?: string; color?: boolean }) => {
      const run = parseRunFile(await readFile(runFile, 'utf8'));
      const format = (options.format ?? 'html').toLowerCase();

      if (format === 'html') {
        const baseline = options.baseline
          ? parseRunFile(await readFile(options.baseline, 'utf8'))
          : undefined;
        const html = reportToHtml(run, baseline ? { baseline } : {});
        if (options.out) {
          const written = await writeArtifact(options.out, html);
          process.stdout.write(`${written}\n`);
        } else {
          process.stdout.write(html);
        }
        return;
      }

      let content: string;
      switch (format) {
        case 'json':
          content = `${reportToJson(run)}\n`;
          break;
        case 'junit':
          content = reportToJunit(run);
          break;
        case 'console':
          content = reportToConsole(run, { color: options.color !== false && Boolean(process.stdout.isTTY) });
          break;
        default:
          throw new Error(`Unknown report format "${format}". Use console, json, junit or html.`);
      }

      if (options.out) {
        const written = await writeArtifact(options.out, content);
        process.stdout.write(`${written}\n`);
      } else {
        process.stdout.write(content);
      }
    });
}
