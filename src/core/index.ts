export * from './types.js';
export {
  EvalcheckError,
  ConfigError,
  EndpointError,
  GraderError,
  EXIT_OK,
  EXIT_CHECK_FAILED,
  EXIT_CONFIG_ERROR,
  EXIT_ENDPOINT_UNREACHABLE,
  isConfigError,
  isEndpointError,
} from './errors.js';
export { createLogger, silentLogger } from './logger.js';

export {
  loadSuite,
  parseSuiteSource,
  normalizeSuite,
  safeParseSuite,
  allCaseChecks,
  DEFAULT_EMBEDDING_MODEL,
} from './config/loader.js';
export { SuiteDefinitionSchema, CheckSchema } from './config/schema.js';
export { suiteJsonSchema, configJsonSchema, SUITE_SCHEMA_URL, CONFIG_SCHEMA_URL } from './config/json-schema.js';
export {
  loadSharedConfig,
  findSharedConfig,
  applySharedConfig,
  expandSuitePaths,
  CONFIG_FILE_NAMES,
} from './config/shared.js';
export type { SharedConfig } from './config/shared.js';
export { loadDataset, parseCsv } from './config/dataset.js';
export type { Dataset, DatasetOptions } from './config/dataset.js';

export { createInterpolator, interpolateEnv, REDACTION_PLACEHOLDER } from './utils/interpolate.js';
export { createRedactor, redactHeaders } from './utils/redact.js';
export { hashSuite, canonicalJson, createRunId } from './utils/hash.js';
export { jsonPathQuery, jsonPathFirst, jsonPathExists, parseJsonPath } from './utils/jsonpath.js';
export {
  tokenize,
  countWords,
  countChars,
  applyNormalizers,
  lexicalOverlap,
  tokenF1,
  rougeL,
  jaccard,
  luhnValid,
  cardIssuer,
} from './utils/text.js';
export { percentile, mean, round, clamp, safeRatio } from './utils/stats.js';

export { buildRequest } from './http/request.js';
export { executeRequest } from './http/client.js';
export { extractResponse, assembleSse } from './http/extract.js';
export { parseSseChunk, isDoneEvent } from './http/sse.js';
export { extractUsage, withCost, sumUsage } from './http/usage.js';
export type { Pricing } from './http/usage.js';
export type { HttpCallOptions, HttpOutcome } from './http/client.js';
export type { ExtractionResult, ResponseSpec, SseAssembly } from './http/extract.js';

export { graders, getGrader } from './graders/index.js';
export { createLocalEmbeddingProvider, cosineSimilarity, defaultCacheDir } from './graders/embedding/local.js';
export { detectPii } from './graders/pii.js';
export { findToolCalls, argsMatch } from './graders/tool-call.js';
export { findRefusal } from './graders/refusal.js';
export { detectLanguage } from './graders/language.js';
export type { LanguageDetection } from './graders/language.js';
export type { ToolCall } from './graders/tool-call.js';
export { clearSchemaCache } from './graders/json-schema.js';
export { clearCustomCheckCache, loadCustomCheck } from './graders/custom.js';
export type { CustomCheckFn, CustomResponse, CustomContext, CustomVerdict } from './graders/custom.js';

export {
  createCassette,
  loadCassette,
  parseCassette,
  serializeCassette,
  exchangeKey,
  CASSETTE_VERSION,
} from './cassette.js';
export type { Cassette, RecordedExchange, RecordedRequest } from './cassette.js';

export { runSuite, runSuiteFile, selectCases, globToRegExp, computeTotals, RUN_SCHEMA_VERSION } from './runner/runner.js';
export type { RunOptions } from './runner/runner.js';
export { RateLimiter, pool } from './runner/limiter.js';

export { startMockServer, createMockServer, answerFor } from './mock/server.js';
export type { MockServerHandle, MockServerOptions } from './mock/server.js';

export {
  compareRuns,
  parseThresholds,
  parseSignificance,
  significanceLabel,
  underpoweredNote,
  METRICS,
} from './compare/compare.js';
export { fisherLowerTail, minimumPValue } from './utils/fisher.js';
export type { CompareOptions, MetricSpec } from './compare/compare.js';

export { reportToConsole } from './report/console.js';
export { reportToJson, parseRunFile, JSON_REPORT_SCHEMA_VERSION } from './report/json.js';
export { reportToJunit } from './report/junit.js';
export { reportToHtml, diffLines } from './report/html.js';
export { reportToMarkdown, markdownMarker } from './report/markdown.js';
export { compareVariants, variantsToConsole, variantsToMarkdown } from './report/variants.js';
export { buildHistory, historyToConsole, historyToMarkdown, historyToHtml, trendSummary } from './report/history.js';
export type { HistoryOptions, HistoryPoint, HistorySeries } from './report/history.js';
export type { VariantColumn, VariantComparison } from './report/variants.js';
export type { MarkdownReporterOptions } from './report/markdown.js';

export {
  saveBaseline,
  loadBaseline,
  listBaselines,
  baselineFilePath,
  resolveBaselinePath,
  DEFAULT_BASELINE_DIR,
} from './baseline.js';
export type { BaselineInfo, SaveBaselineOptions } from './baseline.js';
