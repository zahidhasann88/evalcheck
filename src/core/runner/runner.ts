import type { Dispatcher } from 'undici';
import { createRequire } from 'node:module';

import { getGrader } from '../graders/index.js';
import { buildRequest } from '../http/request.js';
import { executeRequest } from '../http/client.js';
import { createInterpolator, type Interpolator } from '../utils/interpolate.js';
import { createRedactor, redactHeaders, type Redactor } from '../utils/redact.js';
import { createRunId } from '../utils/hash.js';
import { mean, percentile, round } from '../utils/stats.js';
import { silentLogger } from '../logger.js';
import type {
  AttemptResult,
  CaseResult,
  CaseSpec,
  CaseStatus,
  CheckAggregate,
  CheckResult,
  EmbeddingProvider,
  GradeContext,
  Logger,
  RunResult,
  Suite,
} from '../types.js';
import { pool, RateLimiter, defaultSleep, type Sleep } from './limiter.js';

export const RUN_SCHEMA_VERSION = '1.0';

export interface RunOptions {
  suite: Suite;
  /** Hash of the raw suite definition. */
  suiteHash: string;
  /** Maximum number of cases executed in parallel. Default 4. */
  concurrency?: number;
  /** Global request rate limit (requests per second). Unlimited when 0. */
  rps?: number;
  /** Overrides the per-case repeat count. */
  repeat?: number;
  /** Glob pattern; only cases whose id matches are executed. */
  filter?: string;
  tag?: string;
  /** Embedding backend used by the `similarity` check. */
  embeddings?: EmbeddingProvider;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: Sleep;
  dispatcher?: Dispatcher;
  onCase?: (result: CaseResult) => void;
  /** Git information recorded in the run metadata. */
  git?: { commit?: string; branch?: string };
}

export async function runSuite(options: RunOptions): Promise<RunResult> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const env = options.env ?? process.env;

  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();

  const interpolator = createInterpolator({ env });
  const selected = selectCases(options.suite, options.filter);
  const limiter = new RateLimiter(options.rps ?? 0, sleep, now);

  if (
    ['POST', 'PUT', 'PATCH'].includes(options.suite.target.method) &&
    options.suite.target.body === undefined &&
    options.suite.target.preset === 'none'
  ) {
    logger.warn(
      `target.method is ${options.suite.target.method} but no request body is configured - the case input is not sent to the endpoint.`,
    );
  }

  const caseResults = await pool(selected, options.concurrency ?? 4, async (caseSpec) => {
    const result = await runCase({
      caseSpec,
      suite: options.suite,
      interpolator,
      options,
      limiter,
      logger,
      now,
    });
    if (options.onCase) {
      // Callers may log or persist the partial result, so it is redacted too.
      options.onCase(redactCase(result, createRedactor({ values: [...interpolator.secrets] })));
    }
    return result;
  });

  const redactor = createRedactor({ values: [...interpolator.secrets] });
  const redactedCases = caseResults.map((caseResult) => redactCase(caseResult, redactor));

  const finishedAtMs = now();
  const totals = computeTotals(redactedCases);
  const endpointErrors = collectEndpointErrors(redactedCases);

  const result: RunResult = {
    schemaVersion: RUN_SCHEMA_VERSION,
    meta: {
      tool: { name: 'evalcheck', version: toolVersion() },
      schemaVersion: RUN_SCHEMA_VERSION,
      suiteName: options.suite.name,
      suiteHash: options.suiteHash,
      ...(options.suite.sourcePath ? { suitePath: options.suite.sourcePath } : {}),
      runId: createRunId(new Date(startedAtMs)),
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      ...(options.tag ? { tag: options.tag } : {}),
      ...(options.git ? { git: options.git } : {}),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      endpointUnreachable: endpointErrors.length > 0,
      ...(endpointErrors.length > 0 ? { endpointErrors } : {}),
    },
    totals,
    cases: redactedCases,
  };

  return result;
}

export async function runSuiteFile(
  suitePath: string,
  options: Omit<RunOptions, 'suite' | 'suiteHash'> & { baseDir?: string } = {},
): Promise<RunResult> {
  const { loadSuite } = await import('../config/loader.js');
  const { suite, hash } = await loadSuite(suitePath, {
    ...(options.baseDir ? { baseDir: options.baseDir } : {}),
  });
  return runSuite({ ...options, suite, suiteHash: hash });
}

interface RunCaseArgs {
  caseSpec: CaseSpec;
  suite: Suite;
  interpolator: Interpolator;
  options: RunOptions;
  limiter: RateLimiter;
  logger: Logger;
  now: () => number;
}

async function runCase(args: RunCaseArgs): Promise<CaseResult> {
  const { caseSpec, suite, interpolator, options, limiter, logger, now } = args;
  const repeat = resolveRepeat(caseSpec, options.repeat, suite);

  if (caseSpec.skip) {
    return {
      id: caseSpec.id,
      status: 'skipped',
      passRate: 0,
      repeat: 0,
      tags: caseSpec.tags ?? [],
      ...(caseSpec.description ? { description: caseSpec.description } : {}),
      checks: [],
      attempts: [],
      latencyMs: { min: 0, max: 0, mean: 0, p50: 0, p95: 0 },
      durationMs: 0,
    };
  }

  const startedAt = now();
  const attempts: AttemptResult[] = [];

  for (let index = 0; index < repeat; index++) {
    const attempt = await runAttempt({
      caseSpec,
      suite,
      interpolator,
      options,
      limiter,
      logger,
      index,
    });
    attempts.push(attempt);
  }

  const durationMs = now() - startedAt;
  const latencies = attempts.map((a) => a.latencyMs);
  const ttfts = attempts.map((a) => a.ttftMs).filter((v): v is number => v !== undefined);

  const attemptOutcomes = attempts.map((a) => attemptPassed(a));
  const passed = attemptOutcomes.filter(Boolean).length;
  const passRate = attempts.length === 0 ? 0 : passed / attempts.length;

  let status: CaseStatus;
  if (attempts.length === 0) {
    status = 'skipped';
  } else if (passed === attempts.length) {
    status = 'passed';
  } else if (passed === 0) {
    status = 'failed';
  } else {
    status = 'flaky';
  }

  const checks = aggregateChecks(attempts);
  const firstError = attempts.find((a) => a.error)?.error;

  return {
    id: caseSpec.id,
    status,
    passRate,
    repeat,
    tags: caseSpec.tags ?? [],
    ...(caseSpec.description ? { description: caseSpec.description } : {}),
    checks,
    attempts,
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : 0,
      max: latencies.length ? Math.max(...latencies) : 0,
      mean: round(mean(latencies), 2),
      p50: round(percentile(latencies, 50), 2),
      p95: round(percentile(latencies, 95), 2),
    },
    ...(ttfts.length > 0 ? { ttftMs: round(percentile(ttfts, 50), 2) } : {}),
    durationMs,
    ...(firstError ? { error: firstError } : {}),
  };
}

interface RunAttemptArgs {
  caseSpec: CaseSpec;
  suite: Suite;
  interpolator: Interpolator;
  options: RunOptions;
  limiter: RateLimiter;
  logger: Logger;
  index: number;
}

async function runAttempt(args: RunAttemptArgs): Promise<AttemptResult> {
  const { caseSpec, suite, interpolator, options, limiter, logger, index } = args;
  const scope = {
    input: caseSpec.input ?? '',
    vars: caseSpec.vars ?? {},
    case: { ...caseSpec, id: caseSpec.id },
  };

  const request = buildRequest({ suite, caseSpec, interpolator, scope });

  await limiter.acquire();

  const outcome = await executeRequest({
    request,
    timeoutMs: suite.target.timeoutMs,
    retries: suite.target.retries,
    stream: suite.target.response.stream,
    response: suite.target.response,
    logger,
    ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const attempt: AttemptResult = {
    index,
    transportOk: outcome.ok,
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    ...(outcome.statusText !== undefined ? { statusText: outcome.statusText } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    text: outcome.text,
    ...(outcome.json !== undefined ? { json: outcome.json } : {}),
    ...(outcome.bodyJson !== undefined ? { bodyJson: outcome.bodyJson } : {}),
    latencyMs: outcome.latencyMs,
    ...(outcome.ttftMs !== undefined ? { ttftMs: outcome.ttftMs } : {}),
    timestamp: new Date().toISOString(),
    request: {
      method: request.method,
      url: request.url,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
    },
    ...(outcome.headers ? { responseHeaders: outcome.headers } : {}),
    checks: [],
    attempts: outcome.attempts ?? 1,
  };

  for (const warning of outcome.warnings) {
    logger.warn(`case ${caseSpec.id}: ${warning}`);
  }

  attempt.checks = await runChecks({
    attempt,
    caseSpec,
    suite,
    options,
    logger,
  });

  return attempt;
}

async function runChecks(args: {
  attempt: AttemptResult;
  caseSpec: CaseSpec;
  suite: Suite;
  options: RunOptions;
  logger: Logger;
}): Promise<CheckResult[]> {
  const { attempt, caseSpec, suite, options, logger } = args;
  const checks = caseSpec.checks ?? [];
  const results: CheckResult[] = [];

  for (const check of checks) {
    const grader = getGrader(check.type);
    const ctx: GradeContext = {
      text: attempt.text,
      json: attempt.json,
      bodyJson: attempt.bodyJson,
      attempt,
      caseSpec,
      suite,
      check,
      services: { embeddings: options.embeddings as EmbeddingProvider },
      logger,
    };
    const started = Date.now();
    try {
      const result = await grader(ctx);
      const merged: CheckResult = { ...result };
      merged.id = result.id || check.id || check.type;
      merged.durationMs = Date.now() - started;
      if (check.optional !== undefined) merged.optional = check.optional;
      results.push(merged);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`case ${caseSpec.id}: check "${check.type}" failed to run: ${message}`);
      results.push({
        id: check.id ?? check.type,
        type: check.type,
        pass: false,
        reason: `grader error: ${message}`,
        error: message,
        durationMs: Date.now() - started,
        ...(check.optional !== undefined ? { optional: check.optional } : {}),
      });
    }
  }

  return results;
}

/**
 * Redacts a case result. Sensitive request and response headers (authorization,
 * api keys, cookies, ...) are hidden entirely, even when their value was a
 * literal in the suite rather than an environment variable.
 */
function redactCase(caseResult: CaseResult, redactor: Redactor): CaseResult {
  const redacted = redactor.redactDeep(caseResult);
  for (const attempt of redacted.attempts) {
    attempt.request.headers = redactHeaders(attempt.request.headers, redactor);
    if (attempt.responseHeaders) {
      attempt.responseHeaders = redactHeaders(attempt.responseHeaders, redactor);
    }
  }
  return redacted;
}

function attemptPassed(attempt: AttemptResult): boolean {
  if (!attempt.transportOk) return false;
  return attempt.checks.every((check) => check.pass || check.optional === true);
}

function aggregateChecks(attempts: AttemptResult[]): CheckAggregate[] {
  const byId = new Map<string, CheckResult[]>();
  for (const attempt of attempts) {
    for (const check of attempt.checks) {
      const list = byId.get(check.id) ?? [];
      list.push(check);
      byId.set(check.id, list);
    }
  }

  const aggregates: CheckAggregate[] = [];
  for (const [id, list] of byId) {
    const passCount = list.filter((c) => c.pass).length;
    const scores = list.map((c) => c.score).filter((s): s is number => s !== undefined);
    const reasons = [...new Set(list.filter((c) => !c.pass).map((c) => c.reason))];
    aggregates.push({
      id,
      type: list[0]!.type,
      passRate: list.length === 0 ? 0 : passCount / list.length,
      passCount,
      total: list.length,
      scores,
      reasons,
      ...(list[0]!.optional !== undefined ? { optional: list[0]!.optional } : {}),
    });
  }
  return aggregates.sort((a, b) => a.id.localeCompare(b.id));
}

export function computeTotals(cases: CaseResult[]): RunResult['totals'] {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  let errored = 0;
  let checks = 0;
  let checksPassed = 0;
  let requests = 0;

  for (const caseResult of cases) {
    switch (caseResult.status) {
      case 'passed':
        passed++;
        break;
      case 'failed':
        failed++;
        break;
      case 'flaky':
        flaky++;
        break;
      case 'skipped':
        skipped++;
        break;
      case 'error':
        errored++;
        break;
    }
    for (const check of caseResult.checks) {
      checks += check.total;
      checksPassed += check.passCount;
    }
    for (const attempt of caseResult.attempts) {
      requests += attempt.attempts;
    }
  }

  const total = cases.length;
  const passRate = total === 0 ? 0 : (passed + flaky * 0) / total;

  return {
    cases: total,
    passed,
    failed,
    flaky,
    skipped,
    errored,
    passRate: round(passRate, 4),
    checks,
    checksPassed,
    checksFailed: checks - checksPassed,
    requests,
  };
}

function collectEndpointErrors(cases: CaseResult[]): string[] {
  const errors = new Set<string>();
  for (const caseResult of cases) {
    for (const attempt of caseResult.attempts) {
      if (attempt.error && looksUnreachable(attempt.error)) errors.add(attempt.error);
    }
  }
  return [...errors];
}

function looksUnreachable(message: string): boolean {
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(
    message,
  );
}

function resolveRepeat(caseSpec: CaseSpec, override: number | undefined, suite: Suite): number {
  if (override !== undefined) return Math.max(1, override);
  if (caseSpec.repeat !== undefined) return caseSpec.repeat;
  if (suite.defaults?.repeat !== undefined) return suite.defaults.repeat;
  return 1;
}

/** Filters cases by a glob pattern (`*`, `?`, `**`). */
export function selectCases(suite: Suite, filter?: string): CaseSpec[] {
  if (!filter) return suite.cases;
  const matcher = globToRegExp(filter);
  return suite.cases.filter((c) => matcher.test(c.id));
}

export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function toolVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
