import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseSuiteSource } from '../../src/core/config/loader.js';
import { ConfigError } from '../../src/core/errors.js';

const VALID = `
name: demo
target:
  url: http://localhost:9999/chat
  method: POST
  body:
    message: "{{input}}"
  response:
    textPath: "$.reply"
cases:
  - id: hello
    input: hi
    checks:
      - type: contains
        value: hello
`;

function parseError(source: string, sourcePath = '/tmp/suite.yaml'): ConfigError {
  try {
    parseSuiteSource(source, sourcePath);
  } catch (error) {
    return error as ConfigError;
  }
  throw new Error('expected the suite to be rejected');
}

describe('suite loader', () => {
  it('parses a valid suite', () => {
    const { suite, hash } = parseSuiteSource(VALID, '/tmp/suite.yaml');
    expect(suite.name).toBe('demo');
    expect(suite.cases).toHaveLength(1);
    expect(suite.cases[0]!.checks).toHaveLength(1);
    expect(hash).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it('applies defaults to the target', () => {
    const { suite } = parseSuiteSource(VALID, '/tmp/suite.yaml');
    expect(suite.target.method).toBe('POST');
    expect(suite.target.timeoutMs).toBe(30_000);
    expect(suite.target.retries).toEqual({ max: 0, on: [], backoffMs: 0 });
    expect(suite.target.response.stream).toBe(false);
  });

  it('merges default checks into every case', () => {
    const source = `
name: demo
target:
  url: http://localhost:9999/chat
defaults:
  checks:
    - type: length
      max: 100
cases:
  - id: a
    input: x
    checks:
      - type: contains
        value: x
`;
    const { suite } = parseSuiteSource(source, '/tmp/suite.yaml');
    expect(suite.cases[0]!.checks).toHaveLength(2);
    expect(suite.cases[0]!.checks![0]!.type).toBe('length');
  });

  it('rejects unknown keys', () => {
    const error = parseError(`
name: demo
target:
  url: http://x
  typo: true
`);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.issues[0]!.message).toMatch(/Unrecognized key/i);
  });

  it('rejects an unknown check type', () => {
    const error = parseError(`
name: demo
target:
  url: http://x
cases:
  - id: a
    checks:
      - type: does_not_exist
`);
    expect(error.issues[0]!.message).toMatch(/Invalid discriminator value/);
  });

  it('reports the line of a missing field', () => {
    const error = parseError(`
name: demo
target:
  method: POST
`);
    const issue = error.issues.find((i) => i.path === 'target.url');
    expect(issue).toBeDefined();
    expect(issue!.location).toMatch(/suite\.yaml: line 4, column/);
  });

  it('reports the line of an invalid check', () => {
    const error = parseError(`
name: demo
target:
  url: http://x
cases:
  - id: a
    checks:
      - type: contains
`);
    const issue = error.issues.find((i) => i.path.includes('checks'));
    expect(issue).toBeDefined();
    expect(issue!.location).toContain('line');
  });

  it('rejects duplicate case ids', () => {
    const error = parseError(`
name: demo
target:
  url: http://x
cases:
  - id: a
  - id: a
`);
    expect(error.message).toMatch(/Duplicate case id/);
  });

  it('rejects a similarity check without a reference', () => {
    const error = parseError(`
name: demo
target:
  url: http://x
cases:
  - id: a
    checks:
      - type: similarity
        minScore: 0.8
`);
    expect(error.issues[0]!.message).toMatch(/requires "reference" or "references"/);
  });

  it('reports YAML syntax errors', () => {
    const error = parseError('name: demo\n  bad indent: [');
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toMatch(/Cannot parse/);
  });

  it('validates JSON suites as well', () => {
    const json = JSON.stringify({ name: 'demo', target: { url: 'http://x' } });
    const { suite } = parseSuiteSource(json, '/tmp/suite.json');
    expect(suite.name).toBe('demo');
  });

  it('rejects invalid JSON suites', () => {
    const error = parseError('{ "name": "demo", ', '/tmp/suite.json');
    expect(error.message).toMatch(/as JSON/);
  });

  it('resolves relative paths of custom checks', () => {
    const source = `
name: demo
target:
  url: http://x
cases:
  - id: a
    checks:
      - type: custom
        module: ./checks/my-check.mjs
`;
    const { suite } = parseSuiteSource(source, '/tmp/suite.yaml');
    const check = suite.cases[0]!.checks![0]!;
    expect(check.type).toBe('custom');
    if (check.type === 'custom') {
      expect(check.module).toBe(path.resolve('/tmp/checks/my-check.mjs'));
    }
  });

  it('exposes a stable, versioned error message', () => {
    const error = parseError(`
name: demo
target:
  method: POST
`);
    expect(error.details[0]).toMatchSnapshot();
  });
});
