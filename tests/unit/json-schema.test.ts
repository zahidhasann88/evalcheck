import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { suiteJsonSchema, SUITE_SCHEMA_URL } from '../../src/core/config/json-schema.js';

const examplesDir = path.resolve(__dirname, '../../examples/suites');

function compile() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  return ajv.compile(suiteJsonSchema());
}

describe('suite JSON Schema', () => {
  it('is a draft-07 schema with a stable id', () => {
    const schema = suiteJsonSchema();
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$id).toBe(SUITE_SCHEMA_URL);
  });

  it('accepts every example suite', async () => {
    const validate = compile();
    const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const suite = parseYaml(await readFile(path.join(examplesDir, file), 'utf8')) as unknown;
      expect(validate(suite), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('rejects unknown keys and wrong check fields', () => {
    const validate = compile();
    expect(validate({ name: 'x', target: { url: 'http://x' }, tagret: {} })).toBe(false);
    expect(
      validate({
        name: 'x',
        target: { url: 'http://x' },
        cases: [{ id: 'a', checks: [{ type: 'contains', valeu: 'typo' }] }],
      }),
    ).toBe(false);
  });

  it('allows a $schema key so JSON suites can point at the schema', () => {
    const validate = compile();
    expect(validate({ $schema: SUITE_SCHEMA_URL, name: 'x', target: { url: 'http://x' } })).toBe(true);
  });

  it('describes every check type', () => {
    const text = JSON.stringify(suiteJsonSchema());
    expect(text).toContain('Passes when the answer contains some text.');
  });
});
