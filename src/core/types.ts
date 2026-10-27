export const CHECK_TYPES = [
  'contains',
  'not_contains',
  'regex',
  'exact',
  'json_schema',
  'json_path',
  'length',
  'latency',
  'similarity',
  'lexical_overlap',
  'no_pii',
  'custom',
  'tool_call',
] as const;

export type CheckType = (typeof CHECK_TYPES)[number];

export type Normalizer = 'trim' | 'lowercase' | 'uppercase' | 'collapseWhitespace' | 'removePunctuation';

export type PiiCategory = 'email' | 'phone' | 'card' | 'secret';

export type JsonPathOperator = 'equals' | 'matches' | 'exists' | 'gte' | 'lte' | 'contains';

export interface CheckBase {
  /** Optional stable identifier; falls back to `type` + index. */
  id?: string;
  /** Human readable note shown in reports. */
  description?: string;
  /** When true a failure does not fail the case (advisory only). */
  optional?: boolean;
}

export interface ContainsCheck extends CheckBase {
  type: 'contains';
  value: string;
  caseInsensitive?: boolean;
}

export interface NotContainsCheck extends CheckBase {
  type: 'not_contains';
  value: string;
  caseInsensitive?: boolean;
}

export interface RegexCheck extends CheckBase {
  type: 'regex';
  pattern: string;
  flags?: string;
}

export interface ExactCheck extends CheckBase {
  type: 'exact';
  value: string;
  normalize?: Normalizer[];
}

export interface JsonSchemaCheck extends CheckBase {
  type: 'json_schema';
  /** Inline JSON Schema. Mutually exclusive with `schemaFile` and `$ref`. */
  schema?: unknown;
  /** Path (relative to the suite file) of a JSON Schema document. */
  schemaFile?: string;
  /** `$ref` pointing at an external schema file (relative to the suite file). */
  $ref?: string;
}

export interface JsonPathCheck extends CheckBase {
  type: 'json_path';
  path: string;
  equals?: unknown;
  matches?: string;
  exists?: boolean;
  gte?: number;
  lte?: number;
  contains?: unknown;
}

export interface LengthCheck extends CheckBase {
  type: 'length';
  min?: number;
  max?: number;
  unit?: 'chars' | 'words';
}

export interface LatencyCheck extends CheckBase {
  type: 'latency';
  maxMs?: number;
  minMs?: number;
  /** Only meaningful for streaming responses. */
  ttftMaxMs?: number;
}

export interface SimilarityCheck extends CheckBase {
  type: 'similarity';
  reference?: string;
  references?: string[];
  minScore?: number;
  /** Overrides the suite-level embedding model. */
  model?: string;
  revision?: string;
  /** Local directory holding a pre-downloaded model. */
  modelPath?: string;
}

export interface LexicalOverlapCheck extends CheckBase {
  type: 'lexical_overlap';
  reference?: string;
  references?: string[];
  minScore?: number;
  metric?: 'f1' | 'rougeL' | 'jaccard';
}

export interface NoPiiCheck extends CheckBase {
  type: 'no_pii';
  /** Restrict detection to these categories. Default: all of them. */
  categories?: PiiCategory[];
  /** Literal values that are allowed to appear even if they match a pattern. */
  allow?: string[];
}

export interface CustomCheck extends CheckBase {
  type: 'custom';
  /** Path to a JS/TS module exporting a check function. */
  module: string;
  /** Named export to use. Defaults to `default`. */
  export?: string;
}

export interface ToolCallCheck extends CheckBase {
  type: 'tool_call';
  /** Name of the tool that must be called. */
  name?: string;
  /** Expected arguments. Every listed key must match; other arguments are allowed. */
  args?: Record<string, unknown>;
  /** When false, the tool (or any tool when `name` is omitted) must not be called. */
  called?: boolean;
  /** Exact number of matching calls. */
  times?: number;
  /** JSONPath to the tool calls when they are not found automatically. */
  path?: string;
}

export type Check =
  | ContainsCheck
  | NotContainsCheck
  | RegexCheck
  | ExactCheck
  | JsonSchemaCheck
  | JsonPathCheck
  | LengthCheck
  | LatencyCheck
  | SimilarityCheck
  | LexicalOverlapCheck
  | NoPiiCheck
  | CustomCheck
  | ToolCallCheck;

export type RequestPreset = 'openai-chat' | 'anthropic-messages' | 'generic-json' | 'none';

export type StreamMode = false | 'sse';

export interface RetryConfig {
  max: number;
  on: Array<number | 'timeout' | 'network' | '4xx' | '5xx'>;
  backoffMs: number;
}

export interface TargetSpec {
  url: string;
  method: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  preset: RequestPreset;
  response: {
    textPath?: string;
    chunkPath?: string;
    stream: StreamMode;
    /** Expected HTTP status; any 2xx when omitted. */
    status?: number;
  };
  timeoutMs: number;
  retries: RetryConfig;
  model?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TurnSpec {
  input: string;
  vars?: Record<string, unknown>;
  /** Checks run on this turn's reply. */
  checks?: Check[];
  /** JSONPath expressions read from this turn's response into vars for later turns. */
  extract?: Record<string, string>;
}

export interface CaseSpec {
  id: string;
  input?: string;
  /** A conversation: each turn is sent in order with the earlier messages as history. */
  turns?: TurnSpec[];
  vars?: Record<string, unknown>;
  /** Checks run on the reply (the final reply for a conversation). */
  checks?: Check[];
  repeat?: number;
  description?: string;
  tags?: string[];
  skip?: boolean;
}

export interface SuiteDefaults {
  repeat?: number;
  checks?: Check[];
  vars?: Record<string, unknown>;
}

export interface EmbeddingConfig {
  /** Hugging Face model id. */
  model: string;
  /** Pinned revision/commit so scores are reproducible. */
  revision?: string;
  /** Local directory with a pre-downloaded model. */
  modelPath?: string;
  /** Where the model cache lives. */
  cacheDir?: string;
}

export interface SuiteDefinition {
  name: string;
  description?: string;
  target: TargetSpec;
  defaults?: SuiteDefaults;
  cases?: CaseSpec[];
  embedding?: EmbeddingConfig;
}

/** A suite after defaults are merged and relative paths are resolved. */
export interface Suite extends SuiteDefinition {
  cases: CaseSpec[];
  /** Absolute path of the file the suite was loaded from (if any). */
  sourcePath?: string;
  /** Directory used to resolve relative paths. */
  baseDir: string;
}

export interface CheckResult {
  id: string;
  type: CheckType;
  pass: boolean;
  /** 0..1 quality signal. `undefined` means "not applicable". */
  score?: number;
  reason: string;
  details?: Record<string, unknown>;
  /** Wall-clock time spent inside the grader. */
  durationMs?: number;
  error?: string;
  optional?: boolean;
}

export interface AttemptRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface AttemptResult {
  /** Zero-based repeat index. */
  index: number;
  /** True when the HTTP exchange completed (even with a non-2xx status). */
  transportOk: boolean;
  status?: number;
  statusText?: string;
  error?: string;
  /** Extracted response text (post `textPath` / SSE assembly). */
  text: string;
  /** Parsed JSON of the extracted text, when it parses. */
  json?: unknown;
  /** Parsed JSON of the whole response body, when it parses. */
  bodyJson?: unknown;
  latencyMs: number;
  /** Time to first token, only measured for streaming responses. */
  ttftMs?: number;
  timestamp: string;
  request: AttemptRequest;
  responseHeaders?: Record<string, string>;
  checks: CheckResult[];
  /** Number of retry attempts consumed (1 = no retry). */
  attempts: number;
  /** Every turn of a conversation case. */
  turns?: TurnResult[];
}

export interface TurnResult extends Omit<AttemptResult, 'turns'> {
  input: string;
  /** Values read from the response with `extract`. */
  extracted?: Record<string, unknown>;
}

export interface CheckAggregate {
  id: string;
  type: CheckType;
  passRate: number;
  passCount: number;
  total: number;
  scores: number[];
  reasons: string[];
  optional?: boolean;
}

export type CaseStatus = 'passed' | 'failed' | 'flaky' | 'skipped' | 'error';

export interface CaseResult {
  id: string;
  status: CaseStatus;
  passRate: number;
  repeat: number;
  tags: string[];
  description?: string;
  checks: CheckAggregate[];
  attempts: AttemptResult[];
  latencyMs: {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
  };
  ttftMs?: number;
  durationMs: number;
  error?: string;
}

export interface RunTotals {
  cases: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  errored: number;
  passRate: number;
  checks: number;
  checksPassed: number;
  checksFailed: number;
  /** Number of individual HTTP requests issued (including retries). */
  requests: number;
}

export interface RunMetadata {
  tool: { name: string; version: string };
  /** Version of the JSON report schema. */
  schemaVersion: string;
  suiteName: string;
  suiteHash: string;
  suitePath?: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tag?: string;
  git?: { commit?: string; branch?: string };
  node: string;
  platform: string;
  /** True when the target endpoint could not be reached at all. */
  endpointUnreachable?: boolean;
  /** Distinct endpoint errors observed during the run. */
  endpointErrors?: string[];
  /** True when the responses came from a recording instead of the endpoint. */
  replayed?: boolean;
}

export interface RunResult {
  schemaVersion: string;
  meta: RunMetadata;
  totals: RunTotals;
  cases: CaseResult[];
  /** Populated when the run was compared against a baseline. */
  comparison?: ComparisonResult;
}

export interface CaseDelta {
  id: string;
  a: CaseStatus;
  b: CaseStatus;
  kind: 'regression' | 'fix' | 'unchanged-pass' | 'unchanged-fail' | 'new' | 'removed' | 'flaky';
  passRateDelta: number;
  latencyP95DeltaMs: number;
  latencyP95DeltaPct: number;
  similarityDelta?: number;
  failingChecks: string[];
}

export interface CheckTypeDelta {
  type: CheckType;
  aPassRate: number;
  bPassRate: number;
  delta: number;
}

export interface ThresholdSpec {
  raw: string;
  metric: string;
  value: number;
  unit: 'absolute' | 'percent';
}

export interface ThresholdViolation {
  metric: string;
  delta: number;
  threshold: ThresholdSpec;
  direction: 'worse' | 'better';
  message: string;
}

export interface ComparisonResult {
  a: { runId: string; suiteHash: string; finishedAt: string; totals: RunTotals };
  b: { runId: string; suiteHash: string; finishedAt: string; totals: RunTotals };
  passRateDelta: number;
  checkTypeDeltas: CheckTypeDelta[];
  latency: {
    p50A: number;
    p50B: number;
    p50DeltaMs: number;
    p50DeltaPct: number;
    p95A: number;
    p95B: number;
    p95DeltaMs: number;
    p95DeltaPct: number;
  };
  regressions: CaseDelta[];
  fixes: CaseDelta[];
  flaky: CaseDelta[];
  newCases: CaseDelta[];
  removedCases: CaseDelta[];
  similarityDrift: Array<{ id: string; a: number; b: number; delta: number }>;
  thresholds: ThresholdSpec[];
  violations: ThresholdViolation[];
  hasRegressions: boolean;
  suiteChanged: boolean;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly revision?: string;
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose?(): Promise<void>;
}

export interface GradeContext {
  /** The text that graders inspect (already extracted). */
  text: string;
  /** Parsed JSON of `text`, when the text is valid JSON. */
  json: unknown;
  /** Parsed JSON of the whole response body, when the body is valid JSON. */
  bodyJson: unknown;
  attempt: AttemptResult;
  caseSpec: CaseSpec;
  suite: Suite;
  check: Check;
  services: { embeddings: EmbeddingProvider };
  logger: Logger;
}

export type Grader = (ctx: GradeContext) => Promise<CheckResult> | CheckResult;

export interface GraderRegistry {
  [type: string]: Grader;
}
