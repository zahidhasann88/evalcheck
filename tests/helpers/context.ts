import type {
  AttemptResult,
  CaseSpec,
  Check,
  EmbeddingProvider,
  GradeContext,
  Logger,
  Suite,
} from '../../src/core/types.js';

export const silentTestLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function makeSuite(overrides: Partial<Suite> = {}): Suite {
  return {
    name: 'test-suite',
    target: {
      url: 'http://localhost:1/chat',
      method: 'POST',
      preset: 'none',
      response: { stream: false },
      timeoutMs: 1000,
      retries: { max: 0, on: [], backoffMs: 0 },
    },
    defaults: {},
    cases: [],
    embedding: { model: 'test/model' },
    baseDir: process.cwd(),
    ...overrides,
  };
}

export function makeCase(overrides: Partial<CaseSpec> = {}): CaseSpec {
  return { id: 'case-1', input: 'hello', vars: {}, checks: [], ...overrides };
}

export function makeAttempt(overrides: Partial<AttemptResult> = {}): AttemptResult {
  return {
    index: 0,
    transportOk: true,
    status: 200,
    text: '',
    latencyMs: 10,
    timestamp: '2026-01-01T00:00:00.000Z',
    request: { method: 'POST', url: 'http://localhost:1/chat', headers: {} },
    checks: [],
    attempts: 1,
    ...overrides,
  };
}

export interface MakeContextOptions {
  text?: string;
  json?: unknown;
  bodyJson?: unknown;
  attempt?: Partial<AttemptResult>;
  check: Check;
  caseSpec?: Partial<CaseSpec>;
  suite?: Partial<Suite>;
  embeddings?: EmbeddingProvider;
}

export function makeContext(options: MakeContextOptions): GradeContext {
  const attempt = makeAttempt({
    ...(options.text !== undefined ? { text: options.text } : {}),
    ...(options.json !== undefined ? { json: options.json } : {}),
    ...(options.bodyJson !== undefined ? { bodyJson: options.bodyJson } : {}),
    ...options.attempt,
  });

  return {
    text: options.text ?? attempt.text,
    json: options.json ?? attempt.json,
    bodyJson: options.bodyJson ?? attempt.bodyJson,
    attempt,
    caseSpec: makeCase(options.caseSpec),
    suite: makeSuite(options.suite),
    check: options.check,
    services: { embeddings: options.embeddings ?? fakeEmbeddings() },
    logger: silentTestLogger,
  };
}

/** A deterministic, model-free embedding provider for tests. */
export function fakeEmbeddings(map?: Record<string, number[]>): EmbeddingProvider {
  return {
    model: 'fake/embeddings',
    revision: 'test',
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        if (map && map[text]) return Float32Array.from(map[text]);
        // Hash the text into a small deterministic vector.
        const vector = new Array<number>(8).fill(0);
        for (let i = 0; i < text.length; i++) {
          vector[i % 8]! += text.charCodeAt(i);
        }
        const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
        return Float32Array.from(vector.map((v) => v / norm));
      });
    },
  };
}
