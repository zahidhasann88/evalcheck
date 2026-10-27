import { afterEach, describe, expect, it } from 'vitest';

import { parseSuiteSource } from '../../src/core/config/loader.js';
import { argsMatch, findToolCalls, toolCallGrader } from '../../src/core/graders/tool-call.js';
import { startMockServer, type MockServerHandle } from '../../src/core/mock/server.js';
import { runSuite } from '../../src/core/runner/runner.js';
import type { CheckResult, ToolCallCheck } from '../../src/core/types.js';
import { makeContext } from '../helpers/context.js';

const openAi = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Dhaka","unit":"celsius"}' } },
        ],
      },
    },
  ],
};

const anthropic = {
  content: [
    { type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Dhaka' } },
  ],
};

const responses = { output: [{ type: 'function_call', name: 'get_weather', arguments: '{"city":"Dhaka"}' }] };

const gemini = { candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Dhaka' } } }] } }] };

const plain = { reply: 'ok', tool_calls: [{ name: 'get_weather', arguments: { city: 'Dhaka' } }] };

async function grade(check: Omit<ToolCallCheck, 'type'>, bodyJson: unknown): Promise<CheckResult> {
  return toolCallGrader(makeContext({ check: { type: 'tool_call', ...check }, bodyJson, text: 'ok' }));
}

describe('findToolCalls', () => {
  it.each([
    ['OpenAI chat completions', openAi],
    ['OpenAI responses', responses],
    ['Anthropic messages', anthropic],
    ['Gemini', gemini],
    ['a plain tool_calls array', plain],
  ])('reads tool calls from %s', (_name, body) => {
    const calls = findToolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('get_weather');
    expect(calls[0]!.args).toMatchObject({ city: 'Dhaka' });
  });

  it('returns no calls for a plain answer', () => {
    expect(findToolCalls({ choices: [{ message: { content: 'hi' } }] })).toEqual([]);
    expect(findToolCalls({ reply: 'hi' })).toEqual([]);
  });

  it('keeps arguments that are not valid JSON as text', () => {
    const calls = findToolCalls({ tool_calls: [{ name: 'x', arguments: '{oops' }] });
    expect(calls[0]!.args).toBe('{oops');
  });
});

describe('argsMatch', () => {
  it('matches a subset of the arguments', () => {
    expect(argsMatch({ city: 'Dhaka', unit: 'c' }, { city: 'Dhaka' })).toBe(true);
    expect(argsMatch({ filter: { from: 1, to: 2 } }, { filter: { from: 1 } })).toBe(true);
    expect(argsMatch({ city: 'Dhaka' }, { city: 'Paris' })).toBe(false);
    expect(argsMatch({ tags: ['a', 'b'] }, { tags: ['a'] })).toBe(false);
    expect(argsMatch({}, { city: 'Dhaka' })).toBe(false);
  });
});

describe('tool_call check', () => {
  it('passes when the tool is called with matching arguments', async () => {
    const result = await grade({ name: 'get_weather', args: { city: 'Dhaka' } }, openAi);
    expect(result.pass).toBe(true);
  });

  it('explains which argument differs', async () => {
    const result = await grade({ name: 'get_weather', args: { city: 'Paris' } }, anthropic);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('"get_weather" was called with other arguments: args.city is "Dhaka", expected "Paris"');
  });

  it('fails when another tool or no tool is called', async () => {
    expect((await grade({ name: 'lookup_order' }, plain)).reason).toBe(
      'expected a call to "lookup_order" but the response called "get_weather"',
    );
    expect((await grade({ name: 'get_weather' }, { reply: 'hi' })).reason).toBe(
      'expected a call to "get_weather" but no tool was called',
    );
  });

  it('supports called: false with and without a name', async () => {
    expect((await grade({ called: false }, { reply: 'hi' })).pass).toBe(true);
    expect((await grade({ called: false }, plain)).pass).toBe(false);
    expect((await grade({ name: 'delete_account', called: false }, plain)).pass).toBe(true);
    expect((await grade({ name: 'get_weather', called: false }, plain)).pass).toBe(false);
  });

  it('counts calls with times', async () => {
    const twice = { tool_calls: [{ name: 'a', arguments: {} }, { name: 'a', arguments: {} }] };
    expect((await grade({ name: 'a', times: 2 }, twice)).pass).toBe(true);
    expect((await grade({ name: 'a', times: 1 }, twice)).reason).toBe('expected 1 call(s) to "a", found 2');
  });

  it('reads tool calls from a custom path', async () => {
    const body = { result: { actions: [{ name: 'get_weather', args: { city: 'Dhaka' } }] } };
    expect((await grade({ name: 'get_weather' }, body)).pass).toBe(false);
    expect((await grade({ name: 'get_weather', path: '$.result.actions' }, body)).pass).toBe(true);
  });

  it('fails clearly when the response is not JSON', async () => {
    const result = await toolCallGrader(
      makeContext({ check: { type: 'tool_call', name: 'x' }, text: 'plain text' }),
    );
    expect(result.reason).toBe('response is not valid JSON, cannot read tool calls');
  });

  it('requires a name unless called is false', () => {
    expect(() =>
      parseSuiteSource(
        `
name: x
target:
  url: http://x
cases:
  - id: a
    input: hi
    checks:
      - type: tool_call
`,
        '/tmp/suite.yaml',
      ),
    ).toThrow(/Invalid suite file/);
  });
});

describe('tool_call against the mock server', () => {
  let mock: MockServerHandle | undefined;

  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it.each([
    ['/v1/chat/completions', 'openai-chat'],
    ['/v1/messages', 'anthropic-messages'],
    ['/chat', 'generic-json'],
  ])('checks tool calls from %s', async (route, preset) => {
    mock = await startMockServer({ port: 0 });
    const { suite, hash } = parseSuiteSource(
      `
name: tools
target:
  url: ${mock.url}${route}
  preset: ${preset}
cases:
  - id: weather
    input: What is the weather in Dhaka?
    checks:
      - type: tool_call
        name: get_weather
        args:
          city: Dhaka
  - id: chit-chat
    input: hello there
    checks:
      - type: tool_call
        called: false
`,
      '/tmp/suite.yaml',
    );
    const run = await runSuite({ suite, suiteHash: hash });
    expect(run.cases.map((c) => [c.id, c.status])).toEqual([
      ['weather', 'passed'],
      ['chit-chat', 'passed'],
    ]);
  });
});
