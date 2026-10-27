import { afterEach, describe, expect, it } from 'vitest';

import { createCassette, parseCassette, serializeCassette } from '../../src/core/cassette.js';
import { parseSuiteSource } from '../../src/core/config/loader.js';
import { runSuite } from '../../src/core/runner/runner.js';
import type { Logger } from '../../src/core/types.js';
import { jsonResponse, sseResponse, startTestServer, type TestServer } from '../helpers/server.js';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

function suite(url: string, textPath = '$.reply', extra = ''): string {
  return `
name: replay-test
target:
  url: ${url}
  method: POST
  headers:
    authorization: "Bearer \${API_KEY}"
  body:
    message: "{{input}}"
    key: "\${API_KEY}"
  response:
    textPath: "${textPath}"
${extra}
cases:
  - id: case-1
    input: hello
    checks:
      - type: contains
        value: pong
`;
}

function parse(source: string) {
  return parseSuiteSource(source, '/tmp/suite.yaml');
}

function capturingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message: string) => warnings.push(message),
    error: () => {},
  };
}

const env = { API_KEY: 'sk-secret-value-123' };

describe('record and replay', () => {
  it('records every exchange and replays it without calling the endpoint', async () => {
    server = await startTestServer((_req, res) => {
      res.setHeader('set-cookie', 'session=abc123456');
      jsonResponse(res, 200, { reply: 'pong from the server', other: 'pong other' });
    });
    const url = server.url;
    const { suite: loaded, hash } = parse(suite(url));
    const record = createCassette(loaded.name);

    const live = await runSuite({ suite: loaded, suiteHash: hash, record, env });
    expect(live.totals.passed).toBe(1);
    expect(record.runId).toBe(live.meta.runId);
    expect(Object.keys(record.exchanges)).toEqual(['case-1#1#1']);

    await server.close();
    server = undefined;

    const replay = parseCassette(serializeCassette(record));
    const replayed = await runSuite({ suite: loaded, suiteHash: hash, replay, env });
    expect(replayed.totals.passed).toBe(1);
    expect(replayed.meta.replayed).toBe(true);
    expect(replayed.meta.endpointUnreachable).toBe(false);
    expect(replayed.cases[0]!.attempts[0]!.text).toBe('pong from the server');
    expect(replayed.cases[0]!.attempts[0]!.latencyMs).toBe(live.cases[0]!.attempts[0]!.latencyMs);
  });

  it('applies the current textPath to recorded bodies', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'nothing here', other: 'pong other' });
    });
    const first = parse(suite(server.url));
    const record = createCassette(first.suite.name);
    const live = await runSuite({ suite: first.suite, suiteHash: first.hash, record, env });
    expect(live.totals.failed).toBe(1);

    const changed = parse(suite(server.url, '$.other'));
    const replayed = await runSuite({ suite: changed.suite, suiteHash: changed.hash, replay: record, env });
    expect(replayed.cases[0]!.attempts[0]!.text).toBe('pong other');
    expect(replayed.totals.passed).toBe(1);
  });

  it('redacts secrets from the recording', async () => {
    server = await startTestServer((_req, res) => {
      res.setHeader('set-cookie', 'session=abc123456');
      jsonResponse(res, 200, { reply: 'pong' });
    });
    const { suite: loaded, hash } = parse(suite(server.url));
    const record = createCassette(loaded.name);
    await runSuite({ suite: loaded, suiteHash: hash, record, env });

    const text = serializeCassette(record);
    expect(text).not.toContain(env.API_KEY);
    expect(text).not.toContain('abc123456');
    expect(text).not.toContain('authorization');
  });

  it('fails a case without a recorded response instead of calling the endpoint', async () => {
    const { suite: loaded, hash } = parse(suite('http://127.0.0.1:9/chat'));
    const run = await runSuite({ suite: loaded, suiteHash: hash, replay: createCassette(loaded.name), env });
    expect(run.totals.failed).toBe(1);
    expect(run.cases[0]!.error).toMatch(/no recorded response for case-1#1#1/);
    expect(run.meta.endpointUnreachable).toBe(false);
  });

  it('warns when the request differs from the recorded one', async () => {
    server = await startTestServer((_req, res) => jsonResponse(res, 200, { reply: 'pong' }));
    const { suite: loaded, hash } = parse(suite(server.url));
    const record = createCassette(loaded.name);
    await runSuite({ suite: loaded, suiteHash: hash, record, env });

    const same = capturingLogger();
    await runSuite({ suite: loaded, suiteHash: hash, replay: record, env, logger: same });
    expect(same.warnings).toEqual([]);

    const edited = parse(suite(server.url).replace('input: hello', 'input: hello again'));
    const changed = capturingLogger();
    await runSuite({ suite: edited.suite, suiteHash: edited.hash, replay: record, env, logger: changed });
    expect(changed.warnings.join('\n')).toMatch(/differs from the recorded one/);
  });

  it('replays streamed responses', async () => {
    server = await startTestServer(async (_req, res) => {
      await sseResponse(res, [
        { choices: [{ delta: { content: 'pong ' } }] },
        { choices: [{ delta: { content: 'streamed' } }] },
      ]);
    });
    const source = suite(server.url).replace(
      '    textPath: "$.reply"',
      '    chunkPath: "$.choices[0].delta.content"\n    stream: sse',
    );
    const { suite: loaded, hash } = parse(source);
    const record = createCassette(loaded.name);
    const live = await runSuite({ suite: loaded, suiteHash: hash, record, env });
    expect(live.cases[0]!.attempts[0]!.text).toBe('pong streamed');

    const replayed = await runSuite({ suite: loaded, suiteHash: hash, replay: record, env });
    expect(replayed.cases[0]!.attempts[0]!.text).toBe('pong streamed');
    expect(replayed.cases[0]!.attempts[0]!.ttftMs).toBe(live.cases[0]!.attempts[0]!.ttftMs);
  });

  it('rejects files that are not recordings', () => {
    expect(() => parseCassette('{"cases": []}')).toThrow(/Invalid recording/);
    expect(() => parseCassette('{"version": 99, "exchanges": {}}')).toThrow(/Unsupported recording/);
  });
});
