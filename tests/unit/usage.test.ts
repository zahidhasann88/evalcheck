import { afterEach, describe, expect, it } from 'vitest';

import { compareRuns, parseThresholds } from '../../src/core/compare/compare.js';
import { parseSuiteSource } from '../../src/core/config/loader.js';
import { usageGrader } from '../../src/core/graders/usage.js';
import { extractUsage, sumUsage, withCost } from '../../src/core/http/usage.js';
import { startMockServer, type MockServerHandle } from '../../src/core/mock/server.js';
import { reportToConsole } from '../../src/core/report/console.js';
import { reportToMarkdown } from '../../src/core/report/markdown.js';
import { runSuite } from '../../src/core/runner/runner.js';
import { makeContext } from '../helpers/context.js';
import { jsonResponse, sseResponse, startTestServer, type TestServer } from '../helpers/server.js';

describe('extractUsage', () => {
  it.each([
    ['OpenAI chat', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }],
    ['OpenAI responses and Anthropic', { usage: { input_tokens: 10, output_tokens: 5 } }],
    ['Gemini', { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }],
  ])('reads %s usage', (_name, body) => {
    expect(extractUsage(JSON.stringify(body), body, false)).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it('combines usage spread over stream events', () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { text: 'hi' } },
      { type: 'message_delta', usage: { output_tokens: 30 } },
    ];
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    expect(extractUsage(body, undefined, 'sse')).toEqual({ inputTokens: 12, outputTokens: 30, totalTokens: 42 });
  });

  it('reads usage from a custom path and returns nothing when absent', () => {
    const body = { meta: { billing: { input_tokens: 3, output_tokens: 4 } } };
    expect(extractUsage('', body, false)).toBeUndefined();
    expect(extractUsage('', body, false, '$.meta.billing')).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  });

  it('computes cost from prices per million tokens and sums usage', () => {
    const usage = withCost({ inputTokens: 1000, outputTokens: 500 }, { inputPerMillion: 2, outputPerMillion: 10 });
    expect(usage!.cost).toBe(0.007);
    expect(sumUsage([usage, undefined, { inputTokens: 1, totalTokens: 2 }])).toEqual({
      inputTokens: 1001,
      outputTokens: 500,
      totalTokens: 2,
      cost: 0.007,
    });
  });
});

describe('usage check', () => {
  const grade = (check: Record<string, unknown>, usage?: Record<string, number>) =>
    usageGrader(makeContext({ check: { type: 'usage', ...check }, attempt: usage ? { usage } : {} }));

  it('passes within the budget and fails above it', async () => {
    expect((await grade({ maxTotalTokens: 100 }, { totalTokens: 80 })).pass).toBe(true);
    const failed = await grade({ maxOutputTokens: 50, maxCost: 0.01 }, { outputTokens: 60, cost: 0.02 });
    expect(failed.pass).toBe(false);
    expect(failed.reason).toBe('output tokens 60 exceed the budget of 50; cost 0.02 exceed the budget of 0.01');
  });

  it('explains missing usage and missing pricing', async () => {
    expect((await grade({ maxTotalTokens: 1 })).reason).toMatch(/did not report token usage/);
    expect((await grade({ maxCost: 1 }, { totalTokens: 1 })).reason).toMatch(/set target.pricing/);
  });
});

describe('usage in runs', () => {
  let mock: MockServerHandle | undefined;
  let server: TestServer | undefined;

  afterEach(async () => {
    await mock?.close();
    await server?.close();
    mock = undefined;
    server = undefined;
  });

  const suite = (url: string, extra = '') => `
name: usage
target:
  url: ${url}/v1/chat/completions
  preset: openai-chat
  response:
    textPath: "$.choices[0].message.content"
  pricing:
    inputPerMillion: 1
    outputPerMillion: 4
${extra}
cases:
  - id: refund
    input: What is your refund policy?
    checks:
      - type: usage
        maxTotalTokens: 200
        maxCost: 0.001
  - id: hello
    input: hello
`;

  it('records usage and cost per attempt and in the totals', async () => {
    mock = await startMockServer({ port: 0 });
    const { suite: loaded, hash } = parseSuiteSource(suite(mock.url), '/tmp/suite.yaml');
    const run = await runSuite({ suite: loaded, suiteHash: hash });
    const usage = run.cases[0]!.attempts[0]!.usage!;
    expect(usage.inputTokens).toBe(5);
    expect(usage.cost).toBeGreaterThan(0);
    expect(run.cases[0]!.status).toBe('passed');
    expect(run.totals.usage!.attempts).toBe(2);
    expect(run.totals.usage!.totalTokens).toBe(
      run.cases.reduce((sum, c) => sum + c.attempts[0]!.usage!.totalTokens!, 0),
    );
    expect(reportToConsole(run)).toMatch(/tokens\s+in \d+\s+out \d+\s+total \d+\s+cost /);
    expect(reportToMarkdown(run)).toMatch(/Tokens: in \d+ · out \d+/);
  });

  it('compares tokens between runs and enforces thresholds', async () => {
    let words = 10;
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'ok', usage: { input_tokens: 10, output_tokens: words } });
    });
    const { suite: loaded, hash } = parseSuiteSource(
      `
name: usage
target:
  url: ${server.url}
  response:
    textPath: "$.reply"
cases:
  - id: a
    input: hi
`,
      '/tmp/suite.yaml',
    );
    const before = await runSuite({ suite: loaded, suiteHash: hash });
    words = 30;
    const after = await runSuite({ suite: loaded, suiteHash: hash });
    const comparison = compareRuns(before, after, { thresholds: parseThresholds(['tokens=+50%']) });
    expect(comparison.usage).toMatchObject({ tokensA: 20, tokensB: 40, tokensDeltaPct: 100 });
    expect(comparison.violations.map((v) => v.metric)).toEqual(['tokens']);
    after.comparison = comparison;
    expect(reportToMarkdown(after)).toContain('| Tokens per attempt | 20 | 40 | +100.0% |');
  });

  it('reads usage from recorded streams on replay', async () => {
    server = await startTestServer(async (_req, res) => {
      await sseResponse(res, [
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
      ]);
    });
    const { suite: loaded, hash } = parseSuiteSource(
      `
name: usage
target:
  url: ${server.url}
  response:
    stream: sse
    chunkPath: "$.choices[0].delta.content"
cases:
  - id: a
    input: hi
`,
      '/tmp/suite.yaml',
    );
    const { createCassette } = await import('../../src/core/cassette.js');
    const record = createCassette('usage');
    const live = await runSuite({ suite: loaded, suiteHash: hash, record });
    expect(live.cases[0]!.attempts[0]!.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
    const replayed = await runSuite({ suite: loaded, suiteHash: hash, replay: record });
    expect(replayed.cases[0]!.attempts[0]!.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
  });
});
