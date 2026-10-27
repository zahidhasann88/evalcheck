// Unknown keys are rejected so that typos in a suite are reported instead of ignored.

import { z } from 'zod';

export const NormalizerSchema = z.enum([
  'trim',
  'lowercase',
  'uppercase',
  'collapseWhitespace',
  'removePunctuation',
]);

const checkBase = {
  id: z.string().min(1).optional(),
  description: z.string().optional(),
  optional: z.boolean().optional(),
};

export const ContainsCheckSchema = z
  .object({
    type: z.literal('contains'),
    ...checkBase,
    value: z.string(),
    caseInsensitive: z.boolean().optional(),
  })
  .strict();

export const NotContainsCheckSchema = z
  .object({
    type: z.literal('not_contains'),
    ...checkBase,
    value: z.string(),
    caseInsensitive: z.boolean().optional(),
  })
  .strict();

export const RegexCheckSchema = z
  .object({
    type: z.literal('regex'),
    ...checkBase,
    pattern: z.string().min(1),
    flags: z.string().optional(),
  })
  .strict();

export const ExactCheckSchema = z
  .object({
    type: z.literal('exact'),
    ...checkBase,
    value: z.string(),
    normalize: z.array(NormalizerSchema).optional(),
  })
  .strict();

export const JsonSchemaCheckSchema = z
  .object({
    type: z.literal('json_schema'),
    ...checkBase,
    schema: z.unknown().optional(),
    schemaFile: z.string().min(1).optional(),
    $ref: z.string().min(1).optional(),
  })
  .strict();

export const JsonPathCheckSchema = z
  .object({
    type: z.literal('json_path'),
    ...checkBase,
    path: z.string().min(1),
    equals: z.unknown().optional(),
    matches: z.string().optional(),
    exists: z.boolean().optional(),
    gte: z.number().optional(),
    lte: z.number().optional(),
    contains: z.unknown().optional(),
  })
  .strict();

export const LengthCheckSchema = z
  .object({
    type: z.literal('length'),
    ...checkBase,
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    unit: z.enum(['chars', 'words']).optional(),
  })
  .strict();

export const LatencyCheckSchema = z
  .object({
    type: z.literal('latency'),
    ...checkBase,
    maxMs: z.number().int().min(0).optional(),
    minMs: z.number().int().min(0).optional(),
    ttftMaxMs: z.number().int().min(0).optional(),
  })
  .strict();

export const SimilarityCheckSchema = z
  .object({
    type: z.literal('similarity'),
    ...checkBase,
    reference: z.string().optional(),
    references: z.array(z.string()).optional(),
    minScore: z.number().min(-1).max(1).optional(),
    model: z.string().min(1).optional(),
    revision: z.string().min(1).optional(),
    modelPath: z.string().min(1).optional(),
  })
  .strict();

export const LexicalOverlapCheckSchema = z
  .object({
    type: z.literal('lexical_overlap'),
    ...checkBase,
    reference: z.string().optional(),
    references: z.array(z.string()).optional(),
    minScore: z.number().min(0).max(1).optional(),
    metric: z.enum(['f1', 'rougeL', 'jaccard']).optional(),
  })
  .strict();

export const NoPiiCheckSchema = z
  .object({
    type: z.literal('no_pii'),
    ...checkBase,
    categories: z.array(z.enum(['email', 'phone', 'card', 'secret'])).optional(),
    allow: z.array(z.string()).optional(),
  })
  .strict();

export const CustomCheckSchema = z
  .object({
    type: z.literal('custom'),
    ...checkBase,
    module: z.string().min(1),
    export: z.string().min(1).optional(),
  })
  .strict();

export const CheckSchema = z.discriminatedUnion('type', [
  ContainsCheckSchema,
  NotContainsCheckSchema,
  RegexCheckSchema,
  ExactCheckSchema,
  JsonSchemaCheckSchema,
  JsonPathCheckSchema,
  LengthCheckSchema,
  LatencyCheckSchema,
  SimilarityCheckSchema,
  LexicalOverlapCheckSchema,
  NoPiiCheckSchema,
  CustomCheckSchema,
]);

export const RequestPresetSchema = z.enum([
  'openai-chat',
  'anthropic-messages',
  'generic-json',
  'none',
]);

export const RetryConfigSchema = z
  .object({
    max: z.number().int().min(0).max(10).default(0),
    on: z
      .array(
        z.union([
          z.number().int().min(100).max(599),
          z.literal('timeout'),
          z.literal('network'),
          z.literal('4xx'),
          z.literal('5xx'),
        ]),
      )
      .default([]),
    backoffMs: z.number().int().min(0).max(60_000).default(0),
  })
  .strict();

export const ResponseSpecSchema = z
  .object({
    textPath: z.string().min(1).optional(),
    chunkPath: z.string().min(1).optional(),
    stream: z.union([z.boolean(), z.literal('sse')]).optional(),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export const TargetSpecSchema = z
  .object({
    url: z.string().min(1, 'target.url must not be empty'),
    method: z
      .string()
      .regex(/^[A-Za-z]+$/, 'target.method must be an HTTP verb')
      .default('POST'),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    preset: RequestPresetSchema.default('none'),
    response: ResponseSpecSchema.optional(),
    timeoutMs: z.number().int().min(1).max(600_000).default(30_000),
    retries: RetryConfigSchema.optional(),
    model: z.string().optional(),
    system: z.string().optional(),
    maxTokens: z.number().int().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

export const DefaultsSchema = z
  .object({
    repeat: z.number().int().min(1).max(100).optional(),
    checks: z.array(CheckSchema).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const CaseSpecSchema = z
  .object({
    id: z
      .string()
      .min(1, 'case id must not be empty')
      .regex(/^[A-Za-z0-9._-]+$/, 'case id may only contain letters, digits, dot, underscore and dash'),
    input: z.string().optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    checks: z.array(CheckSchema).optional(),
    repeat: z.number().int().min(1).max(100).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    skip: z.boolean().optional(),
  })
  .strict();

export const EmbeddingConfigSchema = z
  .object({
    model: z.string().min(1),
    revision: z.string().min(1).optional(),
    modelPath: z.string().min(1).optional(),
    cacheDir: z.string().min(1).optional(),
  })
  .strict();

export const SuiteDefinitionSchema = z
  .object({
    name: z.string().min(1, 'suite name must not be empty'),
    description: z.string().optional(),
    target: TargetSpecSchema,
    defaults: DefaultsSchema.optional(),
    cases: z.array(CaseSpecSchema).optional(),
    embedding: EmbeddingConfigSchema.optional(),
  })
  .strict();

export type SuiteDefinitionInput = z.input<typeof SuiteDefinitionSchema>;
export type SuiteDefinitionOutput = z.output<typeof SuiteDefinitionSchema>;
