import path from 'node:path';

import { Command } from 'commander';

import { loadSuite } from '../core/config/loader.js';
import { loadDataset } from '../core/config/dataset.js';
import { createLocalEmbeddingProvider } from '../core/graders/embedding/local.js';
import { compareRuns, parseThresholds } from '../core/compare/compare.js';
import { loadBaseline, resolveBaselinePath } from '../core/baseline.js';
import { createCassette, loadCassette, serializeCassette, type Cassette } from '../core/cassette.js';
import { runSuite } from '../core/runner/runner.js';
import { reportToConsole } from '../core/report/console.js';
import { reportToJson } from '../core/report/json.js';
import { reportToJunit } from '../core/report/junit.js';
import { reportToHtml } from '../core/report/html.js';
import { reportToMarkdown } from '../core/report/markdown.js';
import { EXIT_CHECK_FAILED, EXIT_ENDPOINT_UNREACHABLE, EXIT_OK } from '../core/errors.js';
import type { Check, RunResult, Suite } from '../core/types.js';
import {
  configError,
  ensureDir,
  makeLogger,
  readGitInfo,
  runFileName,
  suiteNeedsEmbeddings,
  useColor,
  writeArtifact,
} from './shared.js';

/** File name of the copy of the most recent run inside the `--out` directory. */
export const LATEST_RUN_FILE = 'latest.json';

export interface RunCommandOptions {
  out?: string;
  outFile?: string;
  tag?: string;
  filter?: string;
  concurrency?: string;
  repeat?: string;
  rps?: string;
  format?: string;
  against?: string;
  failOnRegression?: boolean;
  threshold?: string[];
  dataset?: string;
  datasetId?: string;
  datasetInput?: string;
  datasetVars?: string;
  datasetChecks?: string;
  datasetTags?: string;
  embeddingModel?: string;
  embeddingRevision?: string;
  embeddingCache?: string;
  offline?: boolean;
  record?: string;
  replay?: string;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

export function registerRunCommand(program: Command): Command {
  return program
    .command('run')
    .description('Run a test suite against an HTTP endpoint and grade the responses')
    .argument('<suite>', 'path to the suite file (YAML or JSON)')
    .option('--out <dir>', 'directory for the run artifacts', 'runs')
    .option('--out-file <file>', 'explicit path for the formatted report (json, junit, html, markdown, console)')
    .option('--tag <name>', 'free-form tag stored in the run metadata')
    .option('--filter <glob>', 'only run cases whose id matches the glob')
    .option('--concurrency <n>', 'number of cases executed in parallel', '4')
    .option('--repeat <n>', 'number of times every case is executed')
    .option('--rps <n>', 'global request rate limit (requests per second)')
    .option('--format <format>', 'console | json | junit | html | markdown', 'console')
    .option('--against <baseline>', 'compare the run against a baseline: a run file or a saved baseline name (e.g. "baseline")')
    .option('--fail-on-regression', 'exit with code 1 when a case regresses')
    .option('--threshold <spec>', 'comparison threshold, e.g. pass_rate=-0.02', collect, [])
    .option('--dataset <file>', 'load additional cases from a JSONL/CSV file')
    .option('--dataset-id <column>', 'dataset column holding the case id', 'id')
    .option('--dataset-input <column>', 'dataset column holding the case input', 'input')
    .option('--dataset-vars <columns>', 'comma separated dataset columns mapped to vars')
    .option('--dataset-checks <column>', 'dataset column holding a JSON array of checks')
    .option('--dataset-tags <column>', 'dataset column holding a comma separated tag list')
    .option('--embedding-model <id>', 'Hugging Face model id for the similarity check')
    .option('--embedding-revision <rev>', 'pinned model revision (commit) for the similarity check')
    .option('--embedding-cache <dir>', 'directory for the local model cache')
    .option('--offline', 'never download models; fail if the embedding model is missing')
    .option('--record <file>', 'save every response to a recording file')
    .option('--replay <file>', 'grade responses from a recording file instead of calling the endpoint')
    .option('--no-color', 'disable ANSI colors')
    .option('--quiet', 'only print errors')
    .option('--verbose', 'print debug information')
    .action(async (suitePath: string, options: RunCommandOptions) => {
      const code = await runCommand(suitePath, options);
      process.exitCode = code;
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function runCommand(suitePath: string, options: RunCommandOptions): Promise<number> {
  const logger = makeLogger(options);
  if (options.record && options.replay) {
    throw configError('--record and --replay cannot be used together');
  }
  const loaded = await loadSuite(suitePath);
  let suite: Suite = loaded.suite;

  if (options.dataset) {
    const dataset = await loadDataset(options.dataset, {
      idColumn: options.datasetId,
      inputColumn: options.datasetInput,
      ...(options.datasetVars ? { varsColumns: options.datasetVars.split(',').map((c) => c.trim()) } : {}),
      ...(options.datasetChecks ? { checksColumn: options.datasetChecks } : {}),
      ...(options.datasetTags ? { tagsColumn: options.datasetTags } : {}),
      baseChecks: suite.defaults?.checks as Check[] | undefined,
    });
    suite = { ...suite, cases: [...suite.cases, ...dataset.cases] };
  }

  const embeddings = await createEmbeddings(suite, options, logger);
  const git = readGitInfo();
  const concurrency = parsePositiveInt(options.concurrency, 4, '--concurrency');
  const repeat = options.repeat !== undefined ? parsePositiveInt(options.repeat, 1, '--repeat') : undefined;
  const rps = options.rps !== undefined ? parseNonNegativeNumber(options.rps, '--rps') : 0;
  const record = options.record ? createCassette(suite.name) : undefined;
  let replay: Cassette | undefined;
  if (options.replay) {
    replay = await loadCassette(options.replay);
    if (replay.suiteName && replay.suiteName !== suite.name) {
      logger.warn(`the recording was made for suite "${replay.suiteName}", not "${suite.name}"`);
    }
  }

  const run = await runSuite({
    suite,
    suiteHash: loaded.hash,
    concurrency,
    ...(repeat !== undefined ? { repeat } : {}),
    rps,
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
    ...(embeddings ? { embeddings } : {}),
    ...(git ? { git } : {}),
    ...(record ? { record } : {}),
    ...(replay ? { replay } : {}),
    logger,
  });

  if (record && options.record) {
    const written = await writeArtifact(options.record, serializeCassette(record));
    process.stderr.write(`recording saved: ${written}
`);
  }

  const outDir = await ensureDir(options.out ?? 'runs');
  const artifactPath = path.join(outDir, runFileName(suite.name));
  const latestPath = path.join(outDir, LATEST_RUN_FILE);
  await writeArtifact(artifactPath, reportToJson(run));

  let comparisonFailed = false;
  if (options.against) {
    const baseline = await loadBaseline(options.against);
    const thresholds = parseThresholds(options.threshold ?? []);
    const comparison = compareRuns(baseline, run, { thresholds });
    run.comparison = comparison;
    await writeArtifact(artifactPath, reportToJson(run));

    const violations = comparison.violations;
    const regressions = comparison.regressions;
    process.stderr.write('\n');
    process.stderr.write(`comparison against ${await resolveBaselinePath(options.against)}\n`);
    process.stderr.write(
      `  pass rate ${(comparison.passRateDelta * 100).toFixed(2)}pp   latency p95 ${comparison.latency.p95DeltaPct >= 0 ? '+' : ''}${comparison.latency.p95DeltaPct.toFixed(1)}%\n`,
    );
    process.stderr.write(`  regressions ${regressions.length}   fixes ${comparison.fixes.length}   flaky ${comparison.flaky.length}\n`);
    for (const regression of regressions) {
      process.stderr.write(`  ✗ ${regression.id}: ${regression.failingChecks.join(', ') || 'status changed'}\n`);
    }
    for (const fix of comparison.fixes) {
      process.stderr.write(`  ✔ ${fix.id}\n`);
    }
    for (const violation of violations) {
      process.stderr.write(`  ⚠ ${violation.message}\n`);
    }
    comparisonFailed =
      violations.length > 0 || (options.failOnRegression === true && regressions.length > 0);
  }

  await writeArtifact(latestPath, reportToJson(run));

  await emit(run, options, artifactPath);

  if (run.meta.endpointUnreachable) {
    return EXIT_ENDPOINT_UNREACHABLE;
  }
  if (comparisonFailed) {
    return EXIT_CHECK_FAILED;
  }
  const failed = run.totals.failed > 0 || run.totals.flaky > 0 || run.totals.errored > 0;
  return failed ? EXIT_CHECK_FAILED : EXIT_OK;
}

/**
 * Writes the requested report.
 *
 * - The JSON run artifact always goes to `<out>/<timestamp>_<suite>.json`.
 * - `console`, `json` and `markdown` go to stdout, unless `--out-file` is given.
 * - `junit` and `html` go to a file, unless `--out-file` is given.
 */
async function emit(run: RunResult, options: RunCommandOptions, artifactPath: string): Promise<void> {
  const format = (options.format ?? 'console').toLowerCase();
  const outFile = options.outFile ? path.resolve(options.outFile) : undefined;

  switch (format) {
    case 'json': {
      const content = `${reportToJson(run)}\n`;
      if (outFile) {
        process.stdout.write(`${await writeArtifact(outFile, content)}\n`);
      } else {
        process.stdout.write(content);
      }
      break;
    }
    case 'markdown': {
      const content = reportToMarkdown(run);
      if (outFile) {
        process.stdout.write(`${await writeArtifact(outFile, content)}
`);
      } else {
        process.stdout.write(content);
      }
      break;
    }
    case 'junit': {
      const content = reportToJunit(run);
      const file = outFile ?? path.join(path.dirname(artifactPath), `${path.basename(artifactPath, '.json')}.xml`);
      process.stdout.write(`${await writeArtifact(file, content)}\n`);
      break;
    }
    case 'html': {
      const content = reportToHtml(run);
      const file = outFile ?? path.join(path.dirname(artifactPath), `${path.basename(artifactPath, '.json')}.html`);
      process.stdout.write(`${await writeArtifact(file, content)}\n`);
      break;
    }
    case 'console':
    default: {
      const content = reportToConsole(run, {
        color: useColor(options),
        ...(options.quiet ? { quiet: true } : {}),
      });
      if (outFile) {
        await writeArtifact(outFile, content);
        process.stdout.write(`${outFile}\n`);
      } else {
        process.stdout.write(content);
      }
      process.stdout.write(`run artifact: ${artifactPath}\n`);
      break;
    }
  }
}

async function createEmbeddings(
  suite: Suite,
  options: RunCommandOptions,
  logger: ReturnType<typeof makeLogger>,
) {
  if (!suiteNeedsEmbeddings(suite)) return undefined;
  const model = options.embeddingModel ?? suite.embedding?.model;
  const revision = options.embeddingRevision ?? suite.embedding?.revision;
  const cacheDir = options.embeddingCache ?? suite.embedding?.cacheDir;
  return createLocalEmbeddingProvider({
    model: model!,
    ...(revision ? { revision } : {}),
    ...(suite.embedding?.modelPath ? { modelPath: suite.embedding.modelPath } : {}),
    ...(cacheDir ? { cacheDir } : {}),
    offline: options.offline === true,
    logger,
  });
}

function parseNonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number (received "${value}")`);
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number (received "${value}")`);
  }
  return Math.floor(parsed);
}
