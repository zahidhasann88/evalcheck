// @huggingface/transformers is an optional peer dependency, loaded lazily so evalcheck
// works without it unless a `similarity` check is used.

import path from 'node:path';

import type { EmbeddingProvider, Logger } from '../../types.js';

export interface LocalEmbeddingOptions {
  model: string;
  revision?: string;
  /** Local directory containing a pre-downloaded model. */
  modelPath?: string;
  /** Cache directory for downloaded model files. */
  cacheDir?: string;
  /** When true, no network access is allowed. */
  offline?: boolean;
  logger: Logger;
  /** Injected for tests. */
  loadTransformers?: () => Promise<TransformersModule>;
}

export interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<FeatureExtractionPipeline>;
  env: Record<string, unknown> & { cacheDir?: string; localModelPath?: string; allowRemoteModels?: boolean; allowLocalModels?: boolean };
}

export interface FeatureExtractionPipeline {
  (texts: string | string[], options?: Record<string, unknown>): Promise<TensorLike>;
}

export interface TensorLike {
  data: ArrayLike<number> | Float32Array;
  dims: number[];
  tolist?(): number[][];
}

export class EmbeddingBackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingBackendUnavailableError';
  }
}

export function defaultCacheDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return path.join(home, '.cache', 'evalcheck', 'models');
}

export async function createLocalEmbeddingProvider(
  options: LocalEmbeddingOptions,
): Promise<EmbeddingProvider> {
  const modelId = options.modelPath ?? options.model;
  const cacheDir = options.cacheDir ?? defaultCacheDir();

  let transformers: TransformersModule;
  try {
    transformers = await loadTransformers(options);
  } catch (err) {
    if (err instanceof EmbeddingBackendUnavailableError) throw err;
    if (options.offline) {
      throw new EmbeddingBackendUnavailableError(
        `Embedding model "${modelId}" is not available in the local cache and --offline forbids downloading it. Run once without --offline to populate the cache. (${(err as Error).message})`,
      );
    }
    throw err;
  }

  const env = transformers.env;
  // transformers.js caches inside its own package directory by default, which
  // is wiped on every reinstall. A stable location is much friendlier.
  env.cacheDir = cacheDir;
  if (options.modelPath) {
    env.localModelPath = options.modelPath;
    env.allowLocalModels = true;
  }
  if (options.offline) {
    // No remote model downloads: only the local cache may be used.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
  }

  const revision = options.revision ?? 'main';

  if (options.offline) {
    options.logger.info(
      `Offline mode: using the local cache (${cacheDir}) for embedding model "${modelId}" (revision ${revision}).`,
    );
  } else {
    options.logger.info(
      `Loading local embedding model "${modelId}" (revision ${revision}). The first run downloads the model files into ${cacheDir}; later runs are fully offline.`,
    );
  }

  let extractor: FeatureExtractionPipeline;
  try {
    extractor = await transformers.pipeline('feature-extraction', modelId, {
      revision,
      dtype: 'q8',
    });
  } catch {
    if (options.offline) {
      throw new EmbeddingBackendUnavailableError(
        `Embedding model "${modelId}" is not available in the local cache and --offline forbids downloading it. Run once without --offline to populate the cache.`,
      );
    }
    try {
      extractor = await transformers.pipeline('feature-extraction', modelId, { revision });
    } catch (fallbackError) {
      throw new EmbeddingBackendUnavailableError(
        `Failed to load embedding model "${modelId}": ${(fallbackError as Error).message}`,
      );
    }
  }

  return {
    model: modelId,
    ...(options.revision ? { revision: options.revision } : {}),
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      return toVectors(output, texts.length);
    },
  };
}

function toVectors(output: TensorLike, count: number): Float32Array[] {
  const data = output.data;
  if (output.dims.length >= 2) {
    const dim = output.dims[output.dims.length - 1]!;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < count; i++) {
      vectors.push(Float32Array.from(Array.from(data).slice(i * dim, (i + 1) * dim)));
    }
    return vectors;
  }
  if (output.tolist) {
    const rows = output.tolist();
    return rows.map((row) => Float32Array.from(row));
  }
  return [Float32Array.from(Array.from(data))];
}

async function loadTransformers(options: LocalEmbeddingOptions): Promise<TransformersModule> {
  if (options.loadTransformers) return options.loadTransformers();
  try {
    const mod = (await import('@huggingface/transformers')) as unknown as TransformersModule;
    return mod;
  } catch (err) {
    throw new EmbeddingBackendUnavailableError(
      `The optional dependency "@huggingface/transformers" is not installed, so the similarity check cannot run. Install it with "npm install @huggingface/transformers" or use the "lexical_overlap" check instead. (${(err as Error).message})`,
    );
  }
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
