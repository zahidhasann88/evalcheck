import { describe, expect, it } from 'vitest';

import {
  cosineSimilarity,
  createLocalEmbeddingProvider,
  EmbeddingBackendUnavailableError,
  type TransformersModule,
} from '../../src/core/graders/embedding/local.js';
import { similarityGrader } from '../../src/core/graders/similarity.js';
import { makeContext, silentTestLogger } from '../helpers/context.js';

/** A deterministic stand-in for transformers.js. */
function fakeTransformers(): TransformersModule {
  const env: Record<string, unknown> = {};
  const dim = 64;
  return {
    env,
    async pipeline() {
      return async (texts: string | string[]) => {
        const list = Array.isArray(texts) ? texts : [texts];
        const data = new Float32Array(list.length * dim);
        list.forEach((text, index) => {
          // One-hot vector derived from a hash: identical texts are identical
          // vectors, unrelated texts are (almost always) orthogonal.
          data[index * dim + (hashString(text) % dim)] = 1;
        });
        return { data, dims: [list.length, dim] };
      };
    },
  };
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

describe('cosine similarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns 0 for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('local embedding backend', () => {
  it('embeds texts with the injected transformers module', async () => {
    const provider = await createLocalEmbeddingProvider({
      model: 'fake/model',
      loadTransformers: async () => fakeTransformers(),
      logger: silentTestLogger,
    });
    const vectors = await provider.embed(['hello', 'world']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]!.length).toBe(64);
  });

  it('announces the model download', async () => {
    const messages: string[] = [];
    await createLocalEmbeddingProvider({
      model: 'fake/model',
      loadTransformers: async () => fakeTransformers(),
      logger: {
        debug: () => {},
        info: (message: string) => messages.push(message),
        warn: () => {},
        error: () => {},
      },
    });
    expect(messages.join('\n')).toMatch(/downloads the model files/);
  });

  it('fails clearly in offline mode when the model is missing', async () => {
    await expect(
      createLocalEmbeddingProvider({
        model: 'fake/missing',
        offline: true,
        loadTransformers: async () => {
          throw new Error('could not find model');
        },
        logger: silentTestLogger,
      }),
    ).rejects.toThrow(/not available in the local cache/);
  });

  it('explains that the optional dependency is missing', async () => {
    await expect(
      createLocalEmbeddingProvider({
        model: 'fake/model',
        loadTransformers: async () => {
          throw new EmbeddingBackendUnavailableError(
            'The optional dependency "@huggingface/transformers" is not installed',
          );
        },
        logger: silentTestLogger,
      }),
    ).rejects.toThrow(/not installed/);
  });
});

describe('similarity grader', () => {
  it('passes when the response matches the reference', async () => {
    const provider = await createLocalEmbeddingProvider({
      model: 'fake/model',
      loadTransformers: async () => fakeTransformers(),
      logger: silentTestLogger,
    });
    const result = await similarityGrader(
      makeContext({
        check: { type: 'similarity', reference: 'the refund policy', minScore: 0.99 },
        text: 'the refund policy',
        embeddings: provider,
      }),
    );
    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo(1, 4);
  });

  it('fails when the response drifts away from the reference', async () => {
    const provider = await createLocalEmbeddingProvider({
      model: 'fake/model',
      loadTransformers: async () => fakeTransformers(),
      logger: silentTestLogger,
    });
    const result = await similarityGrader(
      makeContext({
        check: { type: 'similarity', reference: 'the refund policy', minScore: 0.99 },
        text: 'completely unrelated content about pandas',
        embeddings: provider,
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.details).toMatchObject({ model: 'fake/model' });
  });
});

/**
 * Optional slow test: uses the real local embedding model.
 * Run it with `EVALCHECK_SLOW=1 pnpm test` - the first run downloads the
 * model (~120 MB) and caches it on disk.
 */
describe.skipIf(process.env.EVALCHECK_SLOW !== '1')('similarity with the real model', () => {
  it('scores identical Bangla sentences close to 1', async () => {
    const provider = await createLocalEmbeddingProvider({
      model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
      logger: silentTestLogger,
    });
    const [a, b] = await provider.embed([
      'ডেলিভারি সাধারণত ২-৩ কর্মদিবসে সম্পন্ন হয়।',
      'ডেলিভারি সাধারণত দুই থেকে তিন কর্মদিবসে সম্পন্ন হয়।',
    ]);
    expect(cosineSimilarity(a!, b!)).toBeGreaterThan(0.6);
  }, 300_000);

  it('grades a full suite against a local endpoint', async () => {
    const { parseSuiteSource } = await import('../../src/core/config/loader.js');
    const { runSuite } = await import('../../src/core/runner/runner.js');
    const { startMockServer } = await import('../../src/core/mock/server.js');

    const handle = await startMockServer({ port: 0 });
    try {
      const provider = await createLocalEmbeddingProvider({
        model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        logger: silentTestLogger,
      });
      const { suite, hash } = parseSuiteSource(
        `
name: similarity-e2e
target:
  url: ${handle.url}/chat
  method: POST
  body:
    message: "{{input}}"
  response:
    textPath: "$.reply"
cases:
  - id: refund
    input: "What is your refund policy?"
    checks:
      - type: similarity
        id: matching-reference
        reference: "Refunds are available within 30 days of purchase."
        minScore: 0.5
      - type: similarity
        id: unrelated-reference
        reference: "The moon is made of green cheese."
        minScore: 0.9
`,
        '/tmp/suite.yaml',
      );
      const run = await runSuite({ suite, suiteHash: hash, embeddings: provider });
      const checks = run.cases[0]!.checks;
      const matching = checks.find((c) => c.id === 'matching-reference');
      const unrelated = checks.find((c) => c.id === 'unrelated-reference');
      expect(matching!.passRate).toBe(1);
      expect(unrelated!.passRate).toBe(0);
      expect(matching).toBeDefined();
      expect(unrelated).toBeDefined();
      expect(run.cases[0]!.status).toBe('failed');
    } finally {
      await handle.close();
    }
  }, 300_000);
});
