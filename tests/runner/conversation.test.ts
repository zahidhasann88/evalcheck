import { afterEach, describe, expect, it } from 'vitest';

import { parseSuiteSource } from '../../src/core/config/loader.js';
import { reportToHtml } from '../../src/core/report/html.js';
import { reportToMarkdown } from '../../src/core/report/markdown.js';
import { runSuite } from '../../src/core/runner/runner.js';
import { startMockServer, type MockServerHandle } from '../../src/core/mock/server.js';
import { jsonResponse, startTestServer, type TestServer } from '../helpers/server.js';

let server: TestServer | undefined;
let mock: MockServerHandle | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
});

async function run(source: string) {
  const { suite, hash } = parseSuiteSource(source, '/tmp/suite.yaml');
  return runSuite({ suite, suiteHash: hash });
}

function bodies(): Array<Record<string, unknown>> {
  return server!.requests.map((r) => JSON.parse(r.body) as Record<string, unknown>);
}

describe('conversations', () => {
  it('sends earlier turns as chat history with the openai-chat preset', async () => {
    server = await startTestServer((_req, res, body) => {
      const messages = (JSON.parse(body) as { messages: unknown[] }).messages;
      jsonResponse(res, 200, { choices: [{ message: { content: `reply ${messages.length}` } }] });
    });
    const result = await run(`
name: chat
target:
  url: ${server.url}
  preset: openai-chat
  system: be brief
  response:
    textPath: "$.choices[0].message.content"
cases:
  - id: convo
    turns:
      - input: first
        checks:
          - type: contains
            value: "reply 2"
      - input: second
    checks:
      - type: contains
        id: final
        value: "reply 4"
`);
    expect(result.cases[0]!.status).toBe('passed');
    expect(bodies()[1]!.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'second' },
    ]);

    const attempt = result.cases[0]!.attempts[0]!;
    expect(attempt.turns).toHaveLength(2);
    expect(attempt.text).toBe('reply 4');
    expect(attempt.checks.map((c) => c.id)).toEqual(['turn-1.contains', 'final']);
    expect(result.cases[0]!.checks.map((c) => c.id)).toEqual(['final', 'turn-1.contains']);
  });

  it('sends history in anthropic-messages and generic-json requests', async () => {
    server = await startTestServer((_req, res) => jsonResponse(res, 200, { reply: 'ok' }));
    await run(`
name: chat
target:
  url: ${server.url}
  preset: anthropic-messages
  response:
    textPath: "$.reply"
cases:
  - id: convo
    turns:
      - input: one
      - input: two
`);
    expect(bodies()[1]!.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' },
    ]);

    server.requests.length = 0;
    await run(`
name: chat
target:
  url: ${server.url}
  preset: generic-json
  response:
    textPath: "$.reply"
cases:
  - id: convo
    turns:
      - input: one
      - input: two
`);
    expect(bodies()[0]!).toEqual({ input: 'one', history: [] });
    expect(bodies()[1]!).toEqual({
      input: 'two',
      history: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'ok' },
      ],
    });
  });

  it('exposes history, conversation id and turn index to custom bodies', async () => {
    server = await startTestServer((_req, res) => jsonResponse(res, 200, { reply: 'ok' }));
    const result = await run(`
name: chat
target:
  url: ${server.url}
  body:
    message: "{{input}}"
    messages: "{{history}}"
    session: "{{conversation.id}}"
    turn: "{{turn.index}}"
  response:
    textPath: "$.reply"
defaults:
  repeat: 2
cases:
  - id: convo
    turns:
      - input: one
      - input: two
`);
    const sent = bodies();
    expect(sent).toHaveLength(4);
    expect(sent[0]!.messages).toEqual([]);
    expect(sent[1]!.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(sent[0]!.turn).toBe('1');
    expect(sent[1]!.turn).toBe('2');
    expect(sent[0]!.session).toBe(sent[1]!.session);
    expect(sent[0]!.session).not.toBe(sent[2]!.session);
    expect(String(sent[0]!.session)).toBe(`${result.meta.runId}-convo-1`);
  });

  it('extracts values from a response into vars for later turns', async () => {
    server = await startTestServer((_req, res, _body, index) => {
      jsonResponse(res, 200, index === 0 ? { reply: 'created', order: { id: 'A-77' } } : { reply: 'done' });
    });
    const result = await run(`
name: chat
target:
  url: ${server.url}
  body:
    message: "{{input}}"
  response:
    textPath: "$.reply"
cases:
  - id: convo
    turns:
      - input: create an order
        extract:
          orderId: "$.order.id"
      - input: "cancel order {{vars.orderId}}"
`);
    expect(bodies()[1]!.message).toBe('cancel order A-77');
    expect(result.cases[0]!.attempts[0]!.turns![0]!.extracted).toEqual({ orderId: 'A-77' });
  });

  it('stops a conversation when a turn cannot be completed', async () => {
    server = await startTestServer((_req, res) => jsonResponse(res, 500, { error: 'boom' }));
    const result = await run(`
name: chat
target:
  url: ${server.url}
  body:
    message: "{{input}}"
cases:
  - id: convo
    turns:
      - input: one
      - input: two
`);
    expect(server.requests).toHaveLength(1);
    expect(result.cases[0]!.status).toBe('failed');
    expect(result.cases[0]!.attempts[0]!.turns).toHaveLength(1);
    expect(result.cases[0]!.error).toMatch(/HTTP 500/);
  });

  it('holds a conversation with the mock server', async () => {
    mock = await startMockServer({ port: 0 });
    const result = await run(`
name: chat
target:
  url: ${mock.url}/v1/chat/completions
  preset: openai-chat
  response:
    textPath: "$.choices[0].message.content"
cases:
  - id: refund-flow
    turns:
      - input: I want a refund
        checks:
          - type: contains
            value: order number
      - input: "It is order #1234"
        checks:
          - type: contains
            value: "#1234"
`);
    expect(result.cases[0]!.status).toBe('passed');

    const html = reportToHtml(result);
    expect(html).toContain('Turn 1');
    expect(html).toContain('It is order #1234');

    const failing = structuredClone(result);
    failing.cases[0]!.status = 'failed';
    failing.cases[0]!.checks[0]!.passRate = 0;
    failing.cases[0]!.attempts[0]!.checks[0]!.pass = false;
    expect(reportToMarkdown(failing)).toContain('Turn 2: It is order #1234');
  });
});

function configIssues(source: string): string {
  try {
    parseSuiteSource(source, '/tmp/suite.yaml');
  } catch (err) {
    return (err as { details: string[] }).details.join('\n');
  }
  return '';
}

describe('conversation suites', () => {
  it('rejects a case with both input and turns', () => {
    expect(
      configIssues(`
name: x
target:
  url: http://x
cases:
  - id: a
    input: hi
    turns:
      - input: hello
`),
    ).toMatch(/either "input" or "turns"/);
  });

  it('validates checks inside turns', () => {
    expect(
      configIssues(`
name: x
target:
  url: http://x
cases:
  - id: a
    turns:
      - input: hello
        checks:
          - type: lexical_overlap
`),
    ).toMatch(/cases\.0\.turns\.0\.checks\.0: lexical_overlap check requires "reference"/);
  });

  it('resolves custom check paths inside turns', () => {
    const { suite } = parseSuiteSource(
      `
name: x
target:
  url: http://x
cases:
  - id: a
    turns:
      - input: hello
        checks:
          - type: custom
            module: ./checks/a.mjs
`,
      '/tmp/project/suite.yaml',
    );
    const check = suite.cases[0]!.turns![0]!.checks![0]!;
    expect(check.type === 'custom' && check.module).toMatch(/project[\\/]checks[\\/]a\.mjs$/);
  });
});
