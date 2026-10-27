import { z } from 'zod';

import { SuiteDefinitionSchema } from './schema.js';

export const SUITE_SCHEMA_URL = 'https://unpkg.com/evalcheck/dist/suite.schema.json';

export function suiteJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(SuiteDefinitionSchema, { io: 'input', target: 'draft-7' });
  return {
    ...schema,
    $id: SUITE_SCHEMA_URL,
    title: 'evalcheck suite',
    description: 'A suite file for evalcheck: the endpoint to call, the test cases and the checks for every answer.',
  };
}
