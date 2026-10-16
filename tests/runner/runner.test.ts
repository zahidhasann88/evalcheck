import { afterEach, describe, expect, it } from 'vitest';

import { loadSuite } from '../../src/core/config/loader.js';
import { runSuite } from '../../src/core/runner/runner.js';
import { parseSuiteSource } from '../../src/core/config/loader.js';
import { jsonResponse, sseResponse, startTestServer, type TestServer } from '../helpers/server.js';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

function suiteFor(target: string, extra = ''): string {
  return `
name: runner-test
target:
  url: ${target}
  method: POST
  headers:
    content-type: application/json
  body:
    message: "{{input}}"
  response:
    textPath: "$.reply"
${extra}
cases:
  - id: case-1
    input: hello
    checks:
      - type: contains
        value: pong
`;
}

async function runSuiteText(source: string, options: Record<string, unknown> = {}) {
  const { suite, hash } = parseSuiteSource(source, '/tmp/suite.yaml');
  return runSuite({ suite, suiteHash: hash, ...options });
}

describe('runner', () => {
  it('executes cases and grades the responses', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'pong from the server' });
    });

    const run = await runSuiteText(suiteFor(server.url));
    expect(run.totals.cases).toBe(1);
    expect(run.totals.passed).toBe(1);
    expect(run.cases[0]!.status).toBe('passed');
    expect(run.cases[0]!.attempts[0]!.text).toBe('pong from the server');
    expect(run.cases[0]!.attempts[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records the request, the response and a timestamp', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'pong' });
    });

    const run = await runSuiteText(suiteFor(server.url));
    const attempt = run.cases[0]!.attempts[0]!;
    expect(attempt.request.method).toBe('POST');
    expect(attempt.request.url).toBe(server.url);
    expect(attempt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(attempt.status).toBe(200);
    expect(run.meta.suiteHash).toMatch(/^sha256:/);
  });

  it('extracts the text with textPath', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { choices: [{ message: { content: 'pong nested' } }] });
    });

    const source = suiteFor(
      server.url,
      `  response:\n    textPath: "$.choices[0].message.content"\n`,
    );
    const run = await runSuiteText(source);
    expect(run.cases[0]!.attempts[0]!.text).toBe('pong nested');
  });

  it('retries failed requests and applies the backoff', async () => {
    server = await startTestServer((_req, res, _body, index) => {
      if (index < 2) {
        jsonResponse(res, 500, { error: 'boom' });
        return;
      }
      jsonResponse(res, 200, { reply: 'pong' });
    });

    const source = suiteFor(
      server.url,
      `  retries:\n    max: 2\n    on: [500]\n    backoffMs: 40\n`,
    );
    const run = await runSuiteText(source);
    expect(server.requests).toHaveLength(3);
    expect(run.cases[0]!.attempts[0]!.attempts).toBe(3);
    expect(run.totals.passed).toBe(1);
  });

  it('gives up after the configured number of retries', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 500, { error: 'always broken' });
    });

    const source = suiteFor(
      server.url,
      `  retries:\n    max: 1\n    on: [5xx]\n    backoffMs: 5\n`,
    );
    const run = await runSuiteText(source);
    expect(server.requests).toHaveLength(2);
    expect(run.cases[0]!.status).toBe('failed');
    expect(run.cases[0]!.attempts[0]!.attempts).toBe(2);
  });

  it('does not retry status codes that are not listed', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 500, { error: 'boom' });
    });

    const source = suiteFor(
      server.url,
      `  retries:\n    max: 3\n    on: [429]\n    backoffMs: 5\n`,
    );
    await runSuiteText(source);
    expect(server.requests).toHaveLength(1);
  });

  it('times out slow responses', async () => {
    server = await startTestServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      jsonResponse(res, 200, { reply: 'too late' });
    });

    const source = suiteFor(
      server.url,
      `  timeoutMs: 80\n  retries:\n    max: 0\n    on: []\n`,
    );
    const run = await runSuiteText(source);
    const attempt = run.cases[0]!.attempts[0]!;
    expect(attempt.transportOk).toBe(false);
    expect(attempt.error).toMatch(/timed out/);
    expect(run.cases[0]!.status).toBe('failed');
  });

  it('retries timeouts when the suite asks for it', async () => {
    server = await startTestServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      jsonResponse(res, 200, { reply: 'too late' });
    });

    const source = suiteFor(
      server.url,
      `  timeoutMs: 60\n  retries:\n    max: 1\n    on: [timeout]\n    backoffMs: 5\n`,
    );
    await runSuiteText(source);
    expect(server.requests).toHaveLength(2);
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    server = await startTestServer(async (_req, res) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active--;
      jsonResponse(res, 200, { reply: 'pong' });
    });

    const source = `
name: concurrency
target:
  url: ${server.url}
  method: POST
cases:
${Array.from({ length: 8 }, (_, i) => `  - id: case-${i}\n    input: hello`).join('\n')}
`;
    const run = await runSuiteText(source, { concurrency: 2 });
    expect(run.totals.cases).toBe(8);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it('limits the request rate', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'pong' });
    });

    const source = `
name: rate
target:
  url: ${server.url}
  method: POST
cases:
${Array.from({ length: 4 }, (_, i) => `  - id: case-${i}\n    input: hello`).join('\n')}
`;
    const started = Date.now();
    await runSuiteText(source, { rps: 20, concurrency: 1 });
    const elapsed = Date.now() - started;
    // 4 requests at 20 rps take at least 150ms.
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });

  it('detects flaky cases when repeats disagree', async () => {
    server = await startTestServer((_req, res, _body, index) => {
      if (index === 1) {
        jsonResponse(res, 200, { reply: 'nope' });
        return;
      }
      jsonResponse(res, 200, { reply: 'pong' });
    });

    const run = await runSuiteText(suiteFor(server.url), { repeat: 3 });
    const caseResult = run.cases[0]!;
    expect(caseResult.status).toBe('flaky');
    expect(caseResult.passRate).toBeCloseTo(2 / 3, 5);
    expect(run.totals.flaky).toBe(1);
  });

  it('marks consistently failing cases as failed', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'nope' });
    });

    const run = await runSuiteText(suiteFor(server.url), { repeat: 3 });
    expect(run.cases[0]!.status).toBe('failed');
    expect(run.cases[0]!.passRate).toBe(0);
    expect(run.totals.failed).toBe(1);
  });

  it('aggregates per-check pass rates across repeats', async () => {
    server = await startTestServer((_req, res, _body, index) => {
      if (index === 0) {
        jsonResponse(res, 200, { reply: 'nope' });
        return;
      }
      jsonResponse(res, 200, { reply: 'pong' });
    });

    const run = await runSuiteText(suiteFor(server.url), { repeat: 2 });
    const check = run.cases[0]!.checks[0]!;
    expect(check.total).toBe(2);
    expect(check.passCount).toBe(1);
    expect(check.passRate).toBe(0.5);
  });

  it('filters cases with a glob', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'pong' });
    });

    const source = `
name: filter
target:
  url: ${server.url}
  method: POST
cases:
  - id: refund-policy
    input: a
  - id: shipping-policy
    input: b
  - id: other
    input: c
`;
    const run = await runSuiteText(source, { filter: '*-policy' });
    expect(run.totals.cases).toBe(2);
  });

  it('flags an unreachable endpoint', async () => {
    const { suite, hash } = parseSuiteSource(
      `
name: unreachable
target:
  url: http://127.0.0.1:1/chat
  method: POST
  timeoutMs: 500
cases:
  - id: a
    input: x
`,
      '/tmp/suite.yaml',
    );
    const run = await runSuite({ suite, suiteHash: hash });
    expect(run.meta.endpointUnreachable).toBe(true);
    expect(run.totals.failed).toBe(1);
  });

  it('redacts secrets from the stored request', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'pong' });
    });

    const source = `
name: secrets
target:
  url: ${server.url}
  method: POST
  headers:
    authorization: "Bearer \${API_KEY}"
  body:
    message: "{{input}}"
cases:
  - id: a
    input: hello
`;
    const { suite, hash } = parseSuiteSource(source, '/tmp/suite.yaml');
    const run = await runSuite({
      suite,
      suiteHash: hash,
      env: { API_KEY: 'super-secret-api-key-value' },
    });
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain('super-secret-api-key-value');
    expect(serialized).toContain('[REDACTED]');
  });

  it('hides sensitive headers even when they are literals in the suite', async () => {
    server = await startTestServer((_req, res) => {
      res.setHeader('set-cookie', 'session=literal-session-cookie');
      jsonResponse(res, 200, { reply: 'pong' });
    });

    const source = `
name: literal-secrets
target:
  url: ${server.url}
  method: POST
  headers:
    x-api-key: literal-api-key-in-suite
    x-request-source: evalcheck
  body:
    message: "{{input}}"
cases:
  - id: a
    input: hello
`;
    const { suite, hash } = parseSuiteSource(source, '/tmp/suite.yaml');
    const streamed: string[] = [];
    const run = await runSuite({
      suite,
      suiteHash: hash,
      onCase: (result) => streamed.push(JSON.stringify(result)),
    });
    const attempt = run.cases[0]!.attempts[0]!;
    expect(attempt.request.headers['x-api-key']).toBe('[REDACTED]');
    expect(attempt.request.headers['x-request-source']).toBe('evalcheck');
    expect(attempt.responseHeaders?.['set-cookie']).toBe('[REDACTED]');
    for (const serialized of [JSON.stringify(run), ...streamed]) {
      expect(serialized).not.toContain('literal-api-key-in-suite');
      expect(serialized).not.toContain('literal-session-cookie');
    }
  });

  it('loads a suite from disk', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'pong' });
    });
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-'));
    const file = path.join(dir, 'suite.yaml');
    await writeFile(file, suiteFor(server.url), 'utf8');
    const { suite, hash } = await loadSuite(file);
    const run = await runSuite({ suite, suiteHash: hash });
    expect(run.totals.passed).toBe(1);
  });
});

describe('streaming', () => {
  it('assembles SSE deltas and records the time to first token', async () => {
    server = await startTestServer(async (_req, res) => {
      await sseResponse(res, [
        { choices: [{ delta: { content: 'po' } }] },
        { choices: [{ delta: { content: 'ng' } }] },
        { choices: [{ delta: { content: '!' } }] },
      ], 20);
    });

    const source = `
name: stream
target:
  url: ${server.url}
  method: POST
  response:
    stream: sse
    chunkPath: "$.choices[0].delta.content"
cases:
  - id: a
    input: hello
    checks:
      - type: contains
        value: "pong!"
`;
    const run = await runSuiteText(source);
    const attempt = run.cases[0]!.attempts[0]!;
    expect(attempt.text).toBe('pong!');
    expect(attempt.ttftMs).toBeGreaterThan(0);
    expect(attempt.ttftMs!).toBeLessThanOrEqual(attempt.latencyMs);
    expect(run.totals.passed).toBe(1);
  });

  it('uses textPath on the final SSE event', async () => {
    server = await startTestServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ answer: 'final answer' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const source = `
name: stream
target:
  url: ${server.url}
  method: POST
  response:
    stream: sse
    textPath: "$.answer"
cases:
  - id: a
    input: hello
    checks:
      - type: exact
        value: "final answer"
`;
    const run = await runSuiteText(source);
    expect(run.cases[0]!.attempts[0]!.text).toBe('final answer');
  });

  it('fails the latency check when the first token is too slow', async () => {
    server = await startTestServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const source = `
name: stream
target:
  url: ${server.url}
  method: POST
  response:
    stream: sse
    chunkPath: "$.choices[0].delta.content"
cases:
  - id: a
    input: hello
    checks:
      - type: latency
        ttftMaxMs: 50
`;
    const run = await runSuiteText(source);
    expect(run.cases[0]!.status).toBe('failed');
    expect(run.cases[0]!.checks[0]!.reasons[0]).toMatch(/time to first token/);
  });
});
