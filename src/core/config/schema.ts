// Unknown keys are rejected so that typos in a suite are reported instead of ignored.

import { z } from 'zod';

import type { Check } from '../types.js';

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
  .strict()
  .describe('Passes when the answer contains some text.');

export const NotContainsCheckSchema = z
  .object({
    type: z.literal('not_contains'),
    ...checkBase,
    value: z.string(),
    caseInsensitive: z.boolean().optional(),
  })
  .strict()
  .describe('Passes when the answer does not contain some text.');

export const RegexCheckSchema = z
  .object({
    type: z.literal('regex'),
    ...checkBase,
    pattern: z.string().min(1),
    flags: z.string().optional(),
  })
  .strict()
  .describe('Passes when the answer matches a regular expression.');

export const ExactCheckSchema = z
  .object({
    type: z.literal('exact'),
    ...checkBase,
    value: z.string(),
    normalize: z.array(NormalizerSchema).optional(),
  })
  .strict()
  .describe('Passes when the answer is exactly some text.');

export const JsonSchemaCheckSchema = z
  .object({
    type: z.literal('json_schema'),
    ...checkBase,
    schema: z.unknown().optional(),
    schemaFile: z.string().min(1).optional(),
    $ref: z.string().min(1).optional(),
  })
  .strict()
  .describe('Passes when the answer is valid JSON for a JSON Schema.');

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
  .strict()
  .describe('Passes when a value inside the JSON answer is correct.');

export const LengthCheckSchema = z
  .object({
    type: z.literal('length'),
    ...checkBase,
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    unit: z.enum(['chars', 'words']).optional(),
  })
  .strict()
  .describe('Passes when the answer is not too short or too long.');

export const LatencyCheckSchema = z
  .object({
    type: z.literal('latency'),
    ...checkBase,
    maxMs: z.number().int().min(0).optional(),
    minMs: z.number().int().min(0).optional(),
    ttftMaxMs: z.number().int().min(0).optional(),
  })
  .strict()
  .describe('Passes when the answer arrives fast enough.');

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
  .strict()
  .describe('Passes when the answer means the same as a reference (local embedding model).');

export const LexicalOverlapCheckSchema = z
  .object({
    type: z.literal('lexical_overlap'),
    ...checkBase,
    reference: z.string().optional(),
    references: z.array(z.string()).optional(),
    minScore: z.number().min(0).max(1).optional(),
    metric: z.enum(['f1', 'rougeL', 'jaccard']).optional(),
  })
  .strict()
  .describe('Passes when the answer uses similar words to a reference.');

export const NoPiiCheckSchema = z
  .object({
    type: z.literal('no_pii'),
    ...checkBase,
    categories: z.array(z.enum(['email', 'phone', 'card', 'secret'])).optional(),
    allow: z.array(z.string()).optional(),
  })
  .strict()
  .describe('Passes when no emails, phone numbers, cards or secrets leak.');

export const CustomCheckSchema = z
  .object({
    type: z.literal('custom'),
    ...checkBase,
    module: z.string().min(1),
    export: z.string().min(1).optional(),
  })
  .strict()
  .describe('Passes when your own JS/TS function returns { pass: true }.');

export const ToolCallCheckSchema = z
  .object({
    type: z.literal('tool_call'),
    ...checkBase,
    name: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    called: z.boolean().optional(),
    times: z.number().int().min(0).optional(),
    path: z.string().min(1).optional(),
  })
  .strict()
  .describe('Passes when the response calls a tool (function), optionally with the expected arguments.');

export const UsageCheckSchema = z
  .object({
    type: z.literal('usage'),
    ...checkBase,
    maxInputTokens: z.number().int().min(0).optional(),
    maxOutputTokens: z.number().int().min(0).optional(),
    maxTotalTokens: z.number().int().min(0).optional(),
    maxCost: z.number().min(0).optional(),
  })
  .strict()
  .describe('Passes when the token usage (and cost) reported by the endpoint stays within a budget.');

export const RefusalCheckSchema = z
  .object({
    type: z.literal('refusal'),
    ...checkBase,
    refused: z.boolean().optional(),
    phrases: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .describe("Passes when the answer is not a refusal (\"I can't help with that\"), or with refused: true when it is.");

const LanguageCodeSchema = z.string().regex(/^[A-Za-z]{2}$/, 'use a two-letter ISO 639-1 code such as "en"');

export const LanguageCheckSchema = z
  .object({
    type: z.literal('language'),
    ...checkBase,
    expected: z.union([LanguageCodeSchema, z.array(LanguageCodeSchema).min(1)]),
  })
  .strict()
  .describe('Passes when the answer is written in the expected language (two-letter code, e.g. "en").');

export const AnyOfCheckSchema = z
  .object({
    type: z.literal('any_of'),
    ...checkBase,
    get checks(): z.ZodArray<z.ZodType<Check>> {
      return z.array(CheckSchema).min(1, 'any_of needs at least one check');
    },
  })
  .strict()
  .describe('Passes when at least one of its checks passes.');

export const AllOfCheckSchema = z
  .object({
    type: z.literal('all_of'),
    ...checkBase,
    get checks(): z.ZodArray<z.ZodType<Check>> {
      return z.array(CheckSchema).min(1, 'all_of needs at least one check');
    },
  })
  .strict()
  .describe('Passes when all of its checks pass. Useful inside any_of and not.');

export const NotCheckSchema = z
  .object({
    type: z.literal('not'),
    ...checkBase,
    get check(): z.ZodType<Check> {
      return CheckSchema;
    },
  })
  .strict()
  .describe('Passes when its check fails.');

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
  ToolCallCheckSchema,
  UsageCheckSchema,
  RefusalCheckSchema,
  LanguageCheckSchema,
  AnyOfCheckSchema,
  AllOfCheckSchema,
  NotCheckSchema,
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
    usagePath: z
      .string()
      .min(1)
      .optional()
      .describe('JSONPath to the token usage object when it is not found automatically.'),
  })
  .strict();

export const PricingSchema = z
  .object({
    inputPerMillion: z.number().min(0),
    outputPerMillion: z.number().min(0),
  })
  .strict()
  .describe('Prices per million input and output tokens, used to compute the cost of every reply.');

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
    pricing: PricingSchema.optional(),
    timeoutMs: z.number().int().min(1).max(600_000).default(30_000),
    retries: RetryConfigSchema.optional(),
    model: z.string().optional(),
    system: z.string().optional(),
    maxTokens: z.number().int().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

const MinPassRateSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('Share of repeats (0 to 1) that must pass, e.g. 0.8 passes a case when 8 of 10 repeats pass.');

export const DefaultsSchema = z
  .object({
    repeat: z.number().int().min(1).max(100).optional(),
    minPassRate: MinPassRateSchema,
    checks: z.array(CheckSchema).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const TurnSpecSchema = z
  .object({
    input: z.string(),
    vars: z.record(z.string(), z.unknown()).optional(),
    checks: z.array(CheckSchema).optional(),
    extract: z
      .record(z.string(), z.string().min(1))
      .optional()
      .describe('JSONPath expressions read from this response into vars for the next turns.'),
  })
  .strict()
  .describe('One message of a conversation. Its checks run on the reply to this message.');

export const CaseSpecSchema = z
  .object({
    id: z
      .string()
      .min(1, 'case id must not be empty')
      .regex(/^[A-Za-z0-9._-]+$/, 'case id may only contain letters, digits, dot, underscore and dash'),
    input: z.string().optional(),
    turns: z
      .array(TurnSpecSchema)
      .min(1, 'turns must contain at least one turn')
      .optional()
      .describe('A conversation sent in order. Case checks run on the final reply.'),
    vars: z.record(z.string(), z.unknown()).optional(),
    checks: z.array(CheckSchema).optional(),
    repeat: z.number().int().min(1).max(100).optional(),
    minPassRate: MinPassRateSchema,
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
    $schema: z.string().optional(),
    name: z.string().min(1, 'suite name must not be empty'),
    description: z.string().optional(),
    target: TargetSpecSchema,
    defaults: DefaultsSchema.optional(),
    cases: z.array(CaseSpecSchema).optional(),
    embedding: EmbeddingConfigSchema.optional(),
    variants: z
      .record(
        z.string().regex(/^[A-Za-z0-9._-]+$/, 'variant names may only contain letters, digits, dot, underscore and dash'),
        TargetSpecSchema.partial(),
      )
      .optional()
      .describe('A/B testing: named overrides of the target. Every variant runs the same cases and the results are compared side by side.'),
  })
  .strict();

export type SuiteDefinitionInput = z.input<typeof SuiteDefinitionSchema>;
export type SuiteDefinitionOutput = z.output<typeof SuiteDefinitionSchema>;
