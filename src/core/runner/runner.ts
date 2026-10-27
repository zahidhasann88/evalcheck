import type { Dispatcher } from 'undici';
import { createRequire } from 'node:module';

import {
  exchangeKey,
  recordExchange,
  recordedRequest,
  redactCassette,
  replayExchange,
  sameRequest,
  type Cassette,
} from '../cassette.js';
import { getGrader } from '../graders/index.js';
import { buildRequest, type BuiltRequest } from '../http/request.js';
import { executeRequest, type HttpOutcome } from '../http/client.js';
import { extractUsage, sumUsage, withCost } from '../http/usage.js';
import { jsonPathQuery } from '../utils/jsonpath.js';
import { createInterpolator, type Interpolator, type TemplateScope } from '../utils/interpolate.js';
import { createRedactor, redactHeaders, type Redactor } from '../utils/redact.js';
import { createRunId } from '../utils/hash.js';
import { mean, percentile, round } from '../utils/stats.js';
import { silentLogger } from '../logger.js';
import type {
  AttemptResult,
  CaseResult,
  CaseSpec,
  CaseStatus,
  ChatMessage,
  Check,
  CheckAggregate,
  CheckResult,
  EmbeddingProvider,
  GradeContext,
  Logger,
  RunResult,
  Suite,
  TokenUsage,
  TurnResult,
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
  /** Overrides the per-case minimum pass rate. */
  minPassRate?: number;
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
  /** Every exchange with the endpoint is written into this recording (redacted). */
  record?: Cassette;
  /** Responses are taken from this recording instead of calling the endpoint. */
  replay?: Cassette;
  /** Name of the target variant, recorded in the run metadata. */
  variant?: string;
}

export async function runSuite(options: RunOptions): Promise<RunResult> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const env = options.env ?? process.env;

  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = createRunId(new Date(startedAtMs));
  const conversationPrefix = options.replay?.runId || runId;
  if (options.record) options.record.runId = runId;

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
      conversationPrefix,
    });
    if (options.onCase) {
      // Callers may log or persist the partial result, so it is redacted too.
      options.onCase(redactCase(result, createRedactor({ values: [...interpolator.secrets] })));
    }
    return result;
  });

  const redactor = createRedactor({ values: [...interpolator.secrets] });
  if (options.record) redactCassette(options.record, redactor);
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
      runId,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      ...(options.tag ? { tag: options.tag } : {}),
      ...(options.git ? { git: options.git } : {}),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      endpointUnreachable: endpointErrors.length > 0,
      ...(endpointErrors.length > 0 ? { endpointErrors } : {}),
      ...(options.replay ? { replayed: true } : {}),
      ...(options.variant ? { variant: options.variant } : {}),
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
  conversationPrefix: string;
}

async function runCase(args: RunCaseArgs): Promise<CaseResult> {
  const { caseSpec, suite, options, now } = args;
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
    const attempt = await runAttempt({ ...args, index });
    attempts.push(attempt);
  }

  const durationMs = now() - startedAt;
  const latencies = attempts.map((a) => a.latencyMs);
  const ttfts = attempts.map((a) => a.ttftMs).filter((v): v is number => v !== undefined);

  const attemptOutcomes = attempts.map((a) => attemptPassed(a));
  const passed = attemptOutcomes.filter(Boolean).length;
  const passRate = attempts.length === 0 ? 0 : passed / attempts.length;

  const minPassRate = options.minPassRate ?? caseSpec.minPassRate;
  let status: CaseStatus;
  if (attempts.length === 0) {
    status = 'skipped';
  } else if (minPassRate !== undefined) {
    status = passRate >= minPassRate ? 'passed' : 'failed';
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
    ...(minPassRate !== undefined ? { minPassRate } : {}),
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

interface RunAttemptArgs extends RunCaseArgs {
  index: number;
}

async function runAttempt(args: RunAttemptArgs): Promise<AttemptResult> {
  const { caseSpec, index, conversationPrefix, logger } = args;
  const conversation = { id: `${conversationPrefix}-${caseSpec.id}-${index + 1}` };

  if (!caseSpec.turns) {
    const turn = await runTurn(args, {
      turnIndex: 0,
      input: caseSpec.input ?? '',
      vars: caseSpec.vars ?? {},
      conversation,
      checks: caseSpec.checks ?? [],
      idPrefix: '',
    });
    const { input: _input, extracted: _extracted, ...rest } = turn;
    return { ...rest, index };
  }

  const turns: TurnResult[] = [];
  const history: ChatMessage[] = [];
  let vars: Record<string, unknown> = { ...(caseSpec.vars ?? {}) };
  const lastIndex = caseSpec.turns.length - 1;

  for (const [turnIndex, turnSpec] of caseSpec.turns.entries()) {
    vars = { ...vars, ...(turnSpec.vars ?? {}) };
    const input = args.interpolator.string(turnSpec.input, {
      vars,
      case: { ...caseSpec, id: caseSpec.id },
      conversation,
      turn: { index: turnIndex + 1 },
    });
    const turn = await runTurn(args, {
      turnIndex,
      input,
      vars,
      history: [...history],
      conversation,
      checks: [...(turnSpec.checks ?? []), ...(turnIndex === lastIndex ? (caseSpec.checks ?? []) : [])],
      idPrefix: `turn-${turnIndex + 1}.`,
      prefixedCount: turnSpec.checks?.length ?? 0,
    });
    if (turnSpec.extract) {
      const extracted = extractVars(turn, turnSpec.extract);
      for (const name of Object.keys(turnSpec.extract)) {
        if (!(name in extracted)) {
          logger.warn(`case ${caseSpec.id} turn ${turnIndex + 1}: extract "${name}" did not match the response`);
        }
      }
      turn.extracted = extracted;
      vars = { ...vars, ...extracted };
    }
    turns.push(turn);
    history.push({ role: 'user', content: input }, { role: 'assistant', content: turn.text });
    if (!turn.transportOk) break;
  }

  const final = turns[turns.length - 1]!;
  const firstError = turns.find((t) => t.error)?.error;
  return {
    index,
    transportOk: turns.length === caseSpec.turns.length && turns.every((t) => t.transportOk),
    ...(final.status !== undefined ? { status: final.status } : {}),
    ...(final.statusText !== undefined ? { statusText: final.statusText } : {}),
    ...(firstError ? { error: firstError } : {}),
    text: final.text,
    ...(final.json !== undefined ? { json: final.json } : {}),
    ...(final.bodyJson !== undefined ? { bodyJson: final.bodyJson } : {}),
    latencyMs: turns.reduce((sum, t) => sum + t.latencyMs, 0),
    ...(final.ttftMs !== undefined ? { ttftMs: final.ttftMs } : {}),
    ...withUsage(sumUsage(turns.map((t) => t.usage))),
    timestamp: turns[0]!.timestamp,
    request: final.request,
    ...(final.responseHeaders ? { responseHeaders: final.responseHeaders } : {}),
    checks: turns.flatMap((t) => t.checks),
    attempts: turns.reduce((sum, t) => sum + t.attempts, 0),
    turns,
  };
}

interface TurnArgs {
  turnIndex: number;
  input: string;
  vars: Record<string, unknown>;
  history?: ChatMessage[];
  conversation: { id: string };
  checks: Check[];
  /** Prefix added to the ids of the first `prefixedCount` checks (all of them when omitted). */
  idPrefix: string;
  prefixedCount?: number;
}

async function runTurn(args: RunAttemptArgs, turnArgs: TurnArgs): Promise<TurnResult> {
  const { caseSpec, suite, interpolator, logger, index } = args;
  const { turnIndex, input, vars, history, conversation } = turnArgs;
  const scope: TemplateScope = {
    input,
    vars,
    case: { ...caseSpec, id: caseSpec.id },
    conversation,
    turn: { index: turnIndex + 1 },
    ...(history ? { history } : {}),
  };

  const request = buildRequest({ suite, caseSpec, interpolator, scope });
  const outcome = await send(args, request, exchangeKey(caseSpec.id, index, turnIndex));
  const usage = withCost(
    extractUsage(outcome.bodyText, outcome.bodyJson, suite.target.response.stream, suite.target.response.usagePath),
    suite.target.pricing,
  );

  const turn: TurnResult = {
    index: turnIndex,
    input,
    transportOk: outcome.ok,
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    ...(outcome.statusText !== undefined ? { statusText: outcome.statusText } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    text: outcome.text,
    ...(outcome.json !== undefined ? { json: outcome.json } : {}),
    ...(outcome.bodyJson !== undefined ? { bodyJson: outcome.bodyJson } : {}),
    latencyMs: outcome.latencyMs,
    ...(outcome.ttftMs !== undefined ? { ttftMs: outcome.ttftMs } : {}),
    ...withUsage(usage),
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

  const label = caseSpec.turns ? `case ${caseSpec.id} turn ${turnIndex + 1}` : `case ${caseSpec.id}`;
  for (const warning of outcome.warnings) {
    logger.warn(`${label}: ${warning}`);
  }

  turn.checks = await runChecks({
    attempt: turn,
    checks: turnArgs.checks,
    idPrefix: turnArgs.idPrefix,
    prefixedCount: turnArgs.prefixedCount ?? turnArgs.checks.length,
    caseSpec,
    suite,
    options: args.options,
    logger,
  });

  return turn;
}

async function send(args: RunAttemptArgs, request: BuiltRequest, key: string): Promise<HttpOutcome> {
  const { suite, options, limiter, logger, interpolator } = args;

  if (options.replay) {
    const exchange = options.replay.exchanges[key];
    if (!exchange) {
      return {
        ok: false,
        bodyText: '',
        text: '',
        latencyMs: 0,
        error: `no recorded response for ${key}; record the suite again with --record`,
        errorKind: 'replay',
        warnings: [],
      };
    }
    const outcome = replayExchange(exchange, suite.target.response, suite.target.response.stream);
    const current = createRedactor({ values: [...interpolator.secrets] }).redactDeep(recordedRequest(request));
    if (!sameRequest(current, exchange.request)) {
      outcome.warnings.push('the request differs from the recorded one (the suite or its inputs changed)');
    }
    return outcome;
  }

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
  if (options.record) options.record.exchanges[key] = recordExchange(request, outcome);
  return outcome;
}

function withUsage(usage: TokenUsage | undefined): { usage?: TokenUsage } {
  return usage ? { usage } : {};
}

function extractVars(turn: TurnResult, extract: Record<string, string>): Record<string, unknown> {
  const document = turn.bodyJson ?? turn.json;
  const out: Record<string, unknown> = {};
  if (document === undefined) return out;
  for (const [name, path] of Object.entries(extract)) {
    try {
      const matches = jsonPathQuery(document, path);
      if (matches.length > 0) out[name] = matches[0];
    } catch {
      continue;
    }
  }
  return out;
}

async function runChecks(args: {
  attempt: AttemptResult;
  checks: Check[];
  idPrefix: string;
  prefixedCount: number;
  caseSpec: CaseSpec;
  suite: Suite;
  options: RunOptions;
  logger: Logger;
}): Promise<CheckResult[]> {
  const { attempt, checks, caseSpec, suite, options, logger } = args;
  const results: CheckResult[] = [];

  for (const [position, check] of checks.entries()) {
    const prefix = position < args.prefixedCount ? args.idPrefix : '';
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
      merged.id = `${prefix}${result.id || check.id || check.type}`;
      merged.durationMs = Date.now() - started;
      if (check.optional !== undefined) merged.optional = check.optional;
      results.push(merged);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`case ${caseSpec.id}: check "${check.type}" failed to run: ${message}`);
      results.push({
        id: `${prefix}${check.id ?? check.type}`,
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
  const usages: TokenUsage[] = [];

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
      if (attempt.usage) usages.push(attempt.usage);
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
    ...(usages.length > 0 ? { usage: { ...sumUsage(usages), attempts: usages.length } } : {}),
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
