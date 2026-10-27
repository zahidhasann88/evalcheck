import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Command } from 'commander';

import { buildHistory, historyToConsole, historyToHtml, historyToMarkdown } from '../core/report/history.js';
import { parseRunFile } from '../core/report/json.js';
import type { RunResult } from '../core/types.js';
import { configError, writeArtifact } from './shared.js';
import { LATEST_RUN_FILE } from './run.js';

interface HistoryCommandOptions {
  suite?: string;
  limit?: string;
  format?: string;
  out?: string;
}

export function registerHistoryCommand(program: Command): Command {
  return program
    .command('history')
    .description('Show how pass rate, latency, tokens and cost changed across stored runs')
    .argument('[dir]', 'directory with run files (searched recursively)', 'runs')
    .option('--suite <name>', 'only this suite')
    .option('--limit <n>', 'only the most recent n runs of every suite')
    .option('--format <format>', 'console | markdown | json | html', 'console')
    .option('--out <file>', 'write the report to a file instead of stdout')
    .action(async (dir: string, options: HistoryCommandOptions) => {
      const limit = options.limit !== undefined ? Number(options.limit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw configError(`--limit must be a positive whole number (received "${options.limit}")`);
      }
      const runs = await readRuns(dir);
      const series = buildHistory(runs, {
        ...(options.suite ? { suite: options.suite } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });

      let content: string;
      switch ((options.format ?? 'console').toLowerCase()) {
        case 'json':
          content = `${JSON.stringify(series, null, 2)}\n`;
          break;
        case 'markdown':
          content = historyToMarkdown(series);
          break;
        case 'html':
          content = historyToHtml(series);
          break;
        case 'console':
          content = historyToConsole(series);
          break;
        default:
          throw configError(`Unknown history format "${options.format}". Use console, markdown, json or html.`);
      }

      if (options.out) {
        process.stdout.write(`${await writeArtifact(options.out, content)}\n`);
      } else {
        process.stdout.write(content);
      }
    });
}

async function readRuns(dir: string): Promise<RunResult[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    throw configError(`Cannot read run directory "${dir}"`, [(err as Error).message]);
  }
  const runs: RunResult[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || path.basename(entry) === LATEST_RUN_FILE) continue;
    try {
      runs.push(parseRunFile(await readFile(path.join(dir, entry), 'utf8')));
    } catch {
      continue;
    }
  }
  return runs;
}
