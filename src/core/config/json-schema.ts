import { z } from 'zod';

import { SuiteDefinitionSchema } from './schema.js';
import { SharedConfigSchema } from './shared.js';

export const SUITE_SCHEMA_URL = 'https://unpkg.com/evalcheck/dist/suite.schema.json';
export const CONFIG_SCHEMA_URL = 'https://unpkg.com/evalcheck/dist/config.schema.json';

/** `target` may come from evalcheck.config.yaml, so the editor schema does not require it. */
export function suiteJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(SuiteDefinitionSchema, { io: 'input', target: 'draft-7' });
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => key !== 'target') : undefined;
  return {
    ...schema,
    ...(required ? { required } : {}),
    $id: SUITE_SCHEMA_URL,
    title: 'evalcheck suite',
    description: 'A suite file for evalcheck: the endpoint to call, the test cases and the checks for every answer.',
  };
}

export function configJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(SharedConfigSchema, { io: 'input', target: 'draft-7' }),
    $id: CONFIG_SCHEMA_URL,
    title: 'evalcheck config',
  };
}
