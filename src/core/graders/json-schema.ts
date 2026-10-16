// External `$ref`s are resolved relative to the suite file and rewritten to internal ids
// so nested references keep working.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

import { ConfigError } from '../errors.js';
import type { GradeContext, Grader } from '../types.js';
import { fail, pass } from './helpers.js';

interface LoadedSchema {
  validate: ValidateFunction;
  schemaId: string;
}

const schemaCache = new Map<string, Promise<LoadedSchema>>();

export async function loadJsonSchema(
  schema: unknown,
  schemaFile: string | undefined,
  ref: string | undefined,
  baseDir: string,
): Promise<LoadedSchema> {
  const key = JSON.stringify({ schema, schemaFile, ref, baseDir });
  const cached = schemaCache.get(key);
  if (cached) return cached;
  const promise = build(schema, schemaFile, ref, baseDir);
  schemaCache.set(key, promise);
  return promise;
}

export function clearSchemaCache(): void {
  schemaCache.clear();
}

async function build(
  inlineSchema: unknown,
  schemaFile: string | undefined,
  ref: string | undefined,
  baseDir: string,
): Promise<LoadedSchema> {
  let schema: unknown;
  let schemaDir = baseDir;

  if (schemaFile) {
    const absolute = path.resolve(baseDir, schemaFile);
    schema = await readSchemaFile(absolute);
    schemaDir = path.dirname(absolute);
  } else if (ref) {
    const absolute = path.resolve(baseDir, ref);
    schema = await readSchemaFile(absolute);
    schemaDir = path.dirname(absolute);
  } else {
    schema = inlineSchema;
  }

  if (schema === undefined || schema === null) {
    throw new ConfigError('json_schema check requires "schema", "schemaFile" or "$ref"');
  }

  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
    validateFormats: true,
  });
  addFormats(ajv);

  const ids = new Map<string, string>();
  let counter = 0;

  const rewrite = async (node: unknown, dir: string): Promise<unknown> => {
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) out.push(await rewrite(item, dir));
      return out;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) {
          out.$ref = await resolveExternalRef(value, dir);
          continue;
        }
        out[key] = await rewrite(value, dir);
      }
      return out;
    }
    return node;
  };

  const resolveExternalRef = async (refValue: string, dir: string): Promise<string> => {
    const [filePart, fragment] = splitFragment(refValue);
    const absolute = path.resolve(dir, filePart);
    let id = ids.get(absolute);
    if (!id) {
      const content = await readSchemaFile(absolute);
      id = `ext_${counter++}`;
      ids.set(absolute, id);
      const processed = await rewrite(content, path.dirname(absolute));
      const withId = { ...(processed as Record<string, unknown>), $id: id };
      ajv.addSchema(withId, id);
    }
    return fragment ? `${id}${fragment}` : id;
  };

  const rewritten = await rewrite(schema, schemaDir);
  const validate = ajv.compile(rewritten as object);
  return { validate, schemaId: 'root' };
}

function splitFragment(ref: string): [string, string] {
  const index = ref.indexOf('#');
  if (index === -1) return [ref, ''];
  return [ref.slice(0, index), ref.slice(index)];
}

async function readSchemaFile(absolute: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read JSON schema "${absolute}"`, [
      { path: absolute, message: err instanceof Error ? err.message : String(err) },
    ]);
  }
  if (absolute.toLowerCase().endsWith('.json')) {
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new ConfigError(`Invalid JSON schema "${absolute}"`, [
        { path: absolute, message: err instanceof Error ? err.message : String(err) },
      ]);
    }
  }
  try {
    return parseYaml(content);
  } catch (err) {
    throw new ConfigError(`Invalid YAML schema "${absolute}"`, [
      { path: absolute, message: err instanceof Error ? err.message : String(err) },
    ]);
  }
}

/** Extracts the JSON document a schema check should validate. */
export function jsonDocumentFor(ctx: GradeContext): { value: unknown; error?: string } {
  const candidate = ctx.json !== undefined ? ctx.json : ctx.bodyJson;
  if (candidate === undefined) {
    if (ctx.text.trim() === '') {
      return { value: undefined, error: 'response body is empty, expected JSON' };
    }
    try {
      return { value: JSON.parse(ctx.text) };
    } catch (err) {
      return {
        value: undefined,
        error: `response is not valid JSON: ${(err as Error).message}`,
      };
    }
  }
  if (typeof candidate === 'string') {
    try {
      return { value: JSON.parse(candidate) };
    } catch (err) {
      return {
        value: undefined,
        error: `response text is not valid JSON: ${(err as Error).message}`,
      };
    }
  }
  return { value: candidate };
}

export const jsonSchemaGrader: Grader = async (ctx) => {
  const check = ctx.check as Extract<GradeContext['check'], { type: 'json_schema' }>;
  const { value, error } = jsonDocumentFor(ctx);
  if (error) {
    return fail(ctx, error, { score: 0, error });
  }

  const loaded = await loadJsonSchema(
    check.schema,
    check.schemaFile,
    check.$ref,
    ctx.suite.baseDir,
  );

  const valid = loaded.validate(value);
  if (valid) {
    return pass(ctx, 'response matches the JSON schema', {
      score: 1,
      details: { schema: check.schemaFile ?? check.$ref ?? 'inline' },
    });
  }

  const errors = (loaded.validate.errors ?? []).map(formatAjvError);
  return fail(ctx, `response does not match the JSON schema: ${errors.join('; ')}`, {
    score: 0,
    details: { errors },
  });
};

function formatAjvError(error: ErrorObject): string {
  const where = error.instancePath || '(root)';
  return `${where} ${error.message ?? 'is invalid'}`;
}
