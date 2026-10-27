import path from 'node:path';

import { Command } from 'commander';

import { loadSuite, type LoadedSuite } from '../core/config/loader.js';
import { expandSuitePaths } from '../core/config/shared.js';
import { loadDataset } from '../core/config/dataset.js';
import { createLocalEmbeddingProvider } from '../core/graders/embedding/local.js';
import {
  compareRuns,
  parseSignificance,
  parseThresholds,
  significanceLabel,
  underpoweredNote,
} from '../core/compare/compare.js';
import { loadBaseline, resolveBaselinePath } from '../core/baseline.js';
import { createCassette, loadCassette, serializeCassette, type Cassette } from '../core/cassette.js';
import { runSuite } from '../core/runner/runner.js';
import { reportToConsole } from '../core/report/console.js';
import { reportToJson } from '../core/report/json.js';
import { reportToJunit } from '../core/report/junit.js';
import { reportToHtml } from '../core/report/html.js';
import { reportToMarkdown } from '../core/report/markdown.js';
import { compareVariants, variantsToConsole, variantsToMarkdown, type VariantComparison } from '../core/report/variants.js';
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
  config?: string;
  out?: string;
  outFile?: string;
  tag?: string;
  filter?: string;
  concurrency?: string;
  repeat?: string;
  minPassRate?: string;
  rps?: string;
  format?: string;
  against?: string;
  failOnRegression?: boolean;
  threshold?: string[];
  significance?: string;
  dataset?: string;
  datasetId?: string;
  datasetInput?: string;
  datasetVars?: string;
  datasetChecks?: string;
  datasetTags?: string;
  variant?: string;
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
    .description('Run test suites against an HTTP endpoint and grade the responses')
    .argument('<suites...>', 'suite files (YAML or JSON) or directories of suite files')
    .option('--config <file>', 'shared config file (default: evalcheck.config.yaml next to each suite)')
    .option('--variant <names>', 'run only these target variants (comma separated)')
    .option('--out <dir>', 'directory for the run artifacts', 'runs')
    .option('--out-file <file>', 'explicit path for the formatted report (json, junit, html, markdown, console)')
    .option('--tag <name>', 'free-form tag stored in the run metadata')
    .option('--filter <glob>', 'only run cases whose id matches the glob')
    .option('--concurrency <n>', 'number of cases executed in parallel', '4')
    .option('--repeat <n>', 'number of times every case is executed')
    .option('--min-pass-rate <rate>', 'share of repeats (0-1) that must pass, e.g. 0.8')
    .option('--rps <n>', 'global request rate limit (requests per second)')
    .option('--format <format>', 'console | json | junit | html | markdown', 'console')
    .option('--against <baseline>', 'compare the run against a baseline: a run file or a saved baseline name (e.g. "baseline")')
    .option('--fail-on-regression', 'exit with code 1 when a case regresses')
    .option('--threshold <spec>', 'comparison threshold, e.g. pass_rate=-0.02', collect, [])
    .option('--significance <alpha>', 'only report pass rate changes that are statistically significant, e.g. 0.05')
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
    .option('--record <file>', 'save every response to a recording file (a directory when running several suites)')
    .option('--replay <file>', 'grade responses from a recording file instead of calling the endpoint')
    .option('--no-color', 'disable ANSI colors')
    .option('--quiet', 'only print errors')
    .option('--verbose', 'print debug information')
    .action(async (suitePaths: string[], options: RunCommandOptions) => {
      const code = await runCommand(suitePaths, options);
      process.exitCode = code;
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface SuiteRun {
  run: RunResult;
  artifactPath: string;
  code: number;
}

interface SuiteJob {
  loaded: LoadedSuite;
  suite: Suite;
  /** Unique name used for output directories and recordings. */
  label: string;
  variant?: string;
}

function suiteJobs(loaded: LoadedSuite, variantOption: string | undefined): SuiteJob[] {
  const { suite } = loaded;
  const variants = suite.variants ?? {};
  const names = Object.keys(variants);
  if (names.length === 0) {
    if (variantOption) throw configError(`Suite "${suite.name}" has no variants`);
    return [{ loaded, suite, label: suite.name }];
  }
  const selected = variantOption ? variantOption.split(',').map((v) => v.trim()) : names;
  for (const name of selected) {
    if (!variants[name]) {
      throw configError(`Suite "${suite.name}" has no variant "${name}" (available: ${names.join(', ')})`);
    }
  }
  return selected.map((variant) => ({
    loaded,
    suite: { ...suite, target: variants[variant]! },
    label: `${suite.name}/${variant}`,
    variant,
  }));
}

function variantGroups(results: SuiteRun[]): RunResult[][] {
  const groups = new Map<string, RunResult[]>();
  for (const { run } of results) {
    if (!run.meta.variant) continue;
    groups.set(run.meta.suiteName, [...(groups.get(run.meta.suiteName) ?? []), run]);
  }
  return [...groups.values()].filter((runs) => runs.length > 1);
}

export async function runCommand(suitePaths: string | string[], options: RunCommandOptions): Promise<number> {
  const logger = makeLogger(options);
  if (options.record && options.replay) {
    throw configError('--record and --replay cannot be used together');
  }
  significanceOption(options);

  const files = await expandSuitePaths(Array.isArray(suitePaths) ? suitePaths : [suitePaths]);
  const format = (options.format ?? 'console').toLowerCase();

  const loadedSuites = [];
  for (const file of files) {
    loadedSuites.push(await loadSuite(file, options.config ? { config: options.config } : {}));
  }
  const jobs = loadedSuites.flatMap((loaded) => suiteJobs(loaded, options.variant));
  const multiple = jobs.length > 1;
  if (multiple && options.against) {
    throw configError('--against compares one run at a time; run each suite separately or pick one --variant');
  }
  if (multiple && options.outFile && (format === 'junit' || format === 'html')) {
    throw configError(`--out-file with --format ${format} needs a single suite`);
  }
  const labels = new Set<string>();
  for (const job of jobs) {
    if (labels.has(job.label)) {
      throw configError(`Two suites are named "${job.suite.name}"; suite names must be unique when running several`);
    }
    labels.add(job.label);
  }

  const results: SuiteRun[] = [];
  for (const job of jobs) {
    results.push(await runOneSuite(job, options, logger, multiple));
  }

  const abTests = variantGroups(results).map((runs) => compareVariants(runs, significanceOption(options)));
  await emit(results, options, format, abTests);

  if (multiple && format === 'console' && !options.outFile) {
    const failed = results.filter((r) => r.code !== EXIT_OK).length;
    process.stdout.write(`\n${results.length} runs: ${results.length - failed} passed, ${failed} failed\n`);
  }

  if (results.some((r) => r.code === EXIT_ENDPOINT_UNREACHABLE)) return EXIT_ENDPOINT_UNREACHABLE;
  if (results.some((r) => r.code === EXIT_CHECK_FAILED)) return EXIT_CHECK_FAILED;
  return EXIT_OK;
}

async function runOneSuite(
  job: SuiteJob,
  options: RunCommandOptions,
  logger: ReturnType<typeof makeLogger>,
  multiple: boolean,
): Promise<SuiteRun> {
  const { loaded, label } = job;
  let suite: Suite = job.suite;

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
  const minPassRate =
    options.minPassRate !== undefined ? parseRate(options.minPassRate, '--min-pass-rate') : undefined;
  const recordPath = options.record ? recordingPath(options.record, label, multiple) : undefined;
  const record = recordPath ? createCassette(suite.name) : undefined;
  let replay: Cassette | undefined;
  if (options.replay) {
    replay = await loadCassette(recordingPath(options.replay, label, multiple));
    if (replay.suiteName && replay.suiteName !== suite.name) {
      logger.warn(`the recording was made for suite "${replay.suiteName}", not "${suite.name}"`);
    }
  }

  const run = await runSuite({
    suite,
    suiteHash: loaded.hash,
    concurrency,
    ...(repeat !== undefined ? { repeat } : {}),
    ...(minPassRate !== undefined ? { minPassRate } : {}),
    rps,
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
    ...(embeddings ? { embeddings } : {}),
    ...(git ? { git } : {}),
    ...(record ? { record } : {}),
    ...(replay ? { replay } : {}),
    ...(job.variant ? { variant: job.variant } : {}),
    logger,
  });

  if (record && recordPath) {
    const written = await writeArtifact(recordPath, serializeCassette(record));
    process.stderr.write(`recording saved: ${written}\n`);
  }

  const outDir = await ensureDir(multiple ? path.join(options.out ?? 'runs', ...label.split('/').map(safeName)) : (options.out ?? 'runs'));
  const artifactPath = path.join(outDir, runFileName(suite.name));
  const latestPath = path.join(outDir, LATEST_RUN_FILE);
  await writeArtifact(artifactPath, reportToJson(run));

  let comparisonFailed = false;
  if (options.against) {
    const baseline = await loadBaseline(options.against);
    const thresholds = parseThresholds(options.threshold ?? []);
    const comparison = compareRuns(baseline, run, { thresholds, ...significanceOption(options) });
    run.comparison = comparison;
    await writeArtifact(artifactPath, reportToJson(run));

    const violations = comparison.violations;
    const regressions = comparison.regressions;
    process.stderr.write('\n');
    process.stderr.write(`comparison against ${await resolveBaselinePath(options.against)}\n`);
    process.stderr.write(
      `  pass rate ${(comparison.passRateDelta * 100).toFixed(2)}pp   latency p95 ${comparison.latency.p95DeltaPct >= 0 ? '+' : ''}${comparison.latency.p95DeltaPct.toFixed(1)}%\n`,
    );
    if (comparison.usage) {
      const pct = comparison.usage.tokensDeltaPct;
      process.stderr.write(`  tokens per attempt ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%\n`);
    }
    process.stderr.write(
      `  regressions ${regressions.length}   fixes ${comparison.fixes.length}   flaky ${comparison.flaky.length}` +
        (comparison.noise ? `   within noise ${comparison.noise.length}` : '') +
        '\n',
    );
    for (const regression of regressions) {
      process.stderr.write(
        `  ✗ ${regression.id}${significanceLabel(regression)}: ${regression.failingChecks.join(', ') || 'status changed'}\n`,
      );
    }
    for (const fix of comparison.fixes) {
      process.stderr.write(`  ✔ ${fix.id}${significanceLabel(fix)}\n`);
    }
    for (const violation of violations) {
      process.stderr.write(`  ⚠ ${violation.message}\n`);
    }
    const note = underpoweredNote(comparison);
    if (note) process.stderr.write(`  note: ${note}\n`);
    comparisonFailed =
      violations.length > 0 || (options.failOnRegression === true && regressions.length > 0);
  }

  await writeArtifact(latestPath, reportToJson(run));

  let code = EXIT_OK;
  if (run.meta.endpointUnreachable) {
    code = EXIT_ENDPOINT_UNREACHABLE;
  } else if (comparisonFailed || run.totals.failed > 0 || run.totals.flaky > 0 || run.totals.errored > 0) {
    code = EXIT_CHECK_FAILED;
  }
  return { run, artifactPath, code };
}

function significanceOption(options: RunCommandOptions): { significance?: number } {
  return options.significance !== undefined ? { significance: parseSignificance(options.significance) } : {};
}

function recordingPath(option: string, label: string, multiple: boolean): string {
  return multiple ? path.join(option, `${safeName(label.replace('/', '-'))}.json`) : option;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * Writes the requested report.
 *
 * - The JSON run artifact always goes to `<out>/<timestamp>_<suite>.json` (`<out>/<suite>/` when
 *   several suites run).
 * - `console`, `json` and `markdown` go to stdout, unless `--out-file` is given. With several
 *   suites, `json` is an array and `markdown` holds one report per suite.
 * - `junit` and `html` go to a file next to each run artifact, unless `--out-file` is given.
 */
async function emit(
  results: SuiteRun[],
  options: RunCommandOptions,
  format: string,
  abTests: VariantComparison[],
): Promise<void> {
  const outFile = options.outFile ? path.resolve(options.outFile) : undefined;

  const output = async (content: string): Promise<void> => {
    if (outFile) {
      process.stdout.write(`${await writeArtifact(outFile, content)}\n`);
    } else {
      process.stdout.write(content);
    }
  };

  switch (format) {
    case 'json': {
      const runs = results.map((r) => JSON.parse(reportToJson(r.run)) as unknown);
      await output(`${JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 2)}\n`);
      break;
    }
    case 'markdown': {
      await output([...results.map((r) => reportToMarkdown(r.run)), ...abTests.map(variantsToMarkdown)].join('\n'));
      break;
    }
    case 'junit':
    case 'html': {
      for (const { run, artifactPath } of results) {
        const content = format === 'junit' ? reportToJunit(run) : reportToHtml(run);
        const extension = format === 'junit' ? 'xml' : 'html';
        const file = outFile ?? path.join(path.dirname(artifactPath), `${path.basename(artifactPath, '.json')}.${extension}`);
        process.stdout.write(`${await writeArtifact(file, content)}\n`);
      }
      break;
    }
    case 'console':
    default: {
      const reports = results.map((r) =>
        reportToConsole(r.run, { color: useColor(options), ...(options.quiet ? { quiet: true } : {}) }),
      );
      if (outFile) {
        await writeArtifact(outFile, reports.join('\n'));
        process.stdout.write(`${outFile}\n`);
      }
      for (const [index, report] of reports.entries()) {
        if (!outFile) process.stdout.write(report);
        process.stdout.write(`run artifact: ${results[index]!.artifactPath}\n`);
      }
      for (const abTest of abTests) {
        process.stdout.write(variantsToConsole(abTest));
      }
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

function parseRate(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be a number between 0 and 1 (received "${value}")`);
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
