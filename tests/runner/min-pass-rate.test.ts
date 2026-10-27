import { afterEach, describe, expect, it } from 'vitest';

import { parseSuiteSource } from '../../src/core/config/loader.js';
import { reportToConsole } from '../../src/core/report/console.js';
import { runSuite } from '../../src/core/runner/runner.js';
import { jsonResponse, startTestServer, type TestServer } from '../helpers/server.js';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function startServer(failEvery: number): Promise<string> {
  server = await startTestServer((_req, res, _body, index) => {
    jsonResponse(res, 200, { reply: (index + 1) % failEvery === 0 ? 'wrong' : 'pong' });
  });
  return server.url;
}

function suite(url: string, caseExtra: string, defaults = ''): string {
  return `
name: min-pass-rate
target:
  url: ${url}
  response:
    textPath: "$.reply"
${defaults}
cases:
  - id: a
    input: hi
    repeat: 10
${caseExtra}
    checks:
      - type: contains
        value: pong
`;
}

async function run(source: string, options: Record<string, unknown> = {}) {
  const { suite: loaded, hash } = parseSuiteSource(source, '/tmp/suite.yaml');
  return runSuite({ suite: loaded, suiteHash: hash, concurrency: 1, ...options });
}

describe('minPassRate', () => {
  it('passes a case when enough repeats pass', async () => {
    const url = await startServer(5);
    const result = await run(suite(url, '    minPassRate: 0.8'));
    expect(result.cases[0]!.passRate).toBe(0.8);
    expect(result.cases[0]!.status).toBe('passed');
    expect(result.cases[0]!.minPassRate).toBe(0.8);
    expect(result.totals.passed).toBe(1);
  });

  it('fails a case below the minimum and explains why', async () => {
    const url = await startServer(3);
    const result = await run(suite(url, '    minPassRate: 0.8'));
    expect(result.cases[0]!.passRate).toBe(0.7);
    expect(result.cases[0]!.status).toBe('failed');
    expect(reportToConsole(result)).toContain('7/10 repeats passed, at least 80% required');
  });

  it('is flaky without a minimum', async () => {
    const url = await startServer(5);
    const result = await run(suite(url, ''));
    expect(result.cases[0]!.status).toBe('flaky');
  });

  it('reads the minimum from defaults and from the run options', async () => {
    const url = await startServer(5);
    expect((await run(suite(url, '', 'defaults:\n  minPassRate: 0.8'))).cases[0]!.status).toBe('passed');
    expect((await run(suite(url, '', 'defaults:\n  minPassRate: 0.9'))).cases[0]!.status).toBe('failed');
    expect((await run(suite(url, '    minPassRate: 0.9'), { minPassRate: 0.5 })).cases[0]!.status).toBe('passed');
  });

  it('rejects values outside 0 to 1', () => {
    expect(() => parseSuiteSource(suite('http://x', '    minPassRate: 1.5'), '/tmp/suite.yaml')).toThrow(
      /Invalid suite file/,
    );
  });
});
