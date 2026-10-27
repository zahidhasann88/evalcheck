import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli/index.js';
import { parseSuiteSource } from '../../src/core/config/loader.js';
import { compareVariants, variantsToConsole, variantsToMarkdown } from '../../src/core/report/variants.js';
import { runSuite } from '../../src/core/runner/runner.js';
import { jsonResponse, startTestServer, type TestServer } from '../helpers/server.js';

let server: TestServer | undefined;
let output = '';

afterEach(async () => {
  await server?.close();
  server = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

async function runCli(args: string[]): Promise<number> {
  process.exitCode = 0;
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  await main(['node', 'evalcheck', ...args]);
  vi.restoreAllMocks();
  output = writes.join('');
  return Number(process.exitCode ?? 0);
}

async function startServer(): Promise<string> {
  server = await startTestServer((req, res, body) => {
    const input = (JSON.parse(body) as { input: string }).input;
    const model = req.headers['x-model'];
    const reply = model === 'candidate' && input === 'second' ? 'wrong answer' : `pong ${input}`;
    jsonResponse(res, 200, { reply, usage: { input_tokens: 10, output_tokens: model === 'candidate' ? 5 : 10 } });
  });
  return server.url;
}

function suite(url: string): string {
  return `
name: ab
target:
  url: ${url}
  preset: generic-json
  headers:
    x-model: current
    x-team: support
  response:
    textPath: "$.reply"
variants:
  current: {}
  candidate:
    headers:
      x-model: candidate
cases:
  - id: first
    input: first
    checks:
      - type: contains
        value: pong
  - id: second
    input: second
    checks:
      - type: contains
        value: pong
`;
}

describe('variants', () => {
  it('builds one target per variant with merged headers', () => {
    const { suite: loaded } = parseSuiteSource(suite('http://x'), '/tmp/suite.yaml');
    expect(Object.keys(loaded.variants!)).toEqual(['current', 'candidate']);
    expect(loaded.variants!.candidate!.headers).toEqual({ 'x-model': 'candidate', 'x-team': 'support' });
    expect(loaded.variants!.candidate!.preset).toBe('generic-json');
    expect(loaded.variants!.current!.headers).toEqual(loaded.target.headers);
  });

  it('reports invalid variants with their path', () => {
    let details = '';
    try {
      parseSuiteSource(suite('http://x').replace('      x-model: candidate', '      x-model: candidate\n    method: "not a verb"'), '/tmp/suite.yaml');
    } catch (err) {
      details = (err as { details: string[] }).details.join('\n');
    }
    expect(details).toContain('variants.candidate.method');
  });

  it('compares the variants side by side', async () => {
    const url = await startServer();
    const { suite: loaded, hash } = parseSuiteSource(suite(url), '/tmp/suite.yaml');
    const runs = [];
    for (const variant of ['current', 'candidate']) {
      runs.push(await runSuite({ suite: { ...loaded, target: loaded.variants![variant]! }, suiteHash: hash, variant }));
    }
    const comparison = compareVariants(runs);
    expect(comparison.columns.map((c) => c.variant)).toEqual(['current', 'candidate']);
    expect(comparison.columns[1]!.comparison!.regressions.map((d) => d.id)).toEqual(['second']);

    const text = variantsToConsole(comparison);
    expect(text).toMatch(/second\s+✔\s+✗/);
    expect(text).toMatch(/pass rate\s+100\.0%\s+50\.0%/);
    expect(text).toMatch(/tokens \/ attempt\s+20\s+15 \(-25\.0%\)/);
    expect(text).toContain('candidate vs current: 1 worse (second), 0 better');
    expect(variantsToMarkdown(comparison)).toContain('| second | ✔ | ✗ |');
  });

  it('runs every variant from the CLI and prints the table', async () => {
    const url = await startServer();
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-ab-'));
    const file = path.join(dir, 'suite.yaml');
    await writeFile(file, suite(url), 'utf8');
    const out = path.join(dir, 'runs');

    expect(await runCli(['run', file, '--out', out])).toBe(1);
    expect(output).toContain('A/B · ab');
    expect(output).toContain('evalcheck · ab (candidate)');
    expect((await readdir(path.join(out, 'ab'))).sort()).toEqual(['candidate', 'current']);

    expect(await runCli(['run', file, '--out', out, '--variant', 'current'])).toBe(0);
    expect(output).not.toContain('A/B ·');

    expect(await runCli(['run', file, '--variant', 'missing'])).toBe(2);
    expect(output).toContain('has no variant "missing" (available: current, candidate)');
    expect(await runCli(['run', file, '--against', 'baseline'])).toBe(2);
  });

  it('records and replays each variant', async () => {
    const url = await startServer();
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-ab-'));
    const file = path.join(dir, 'suite.yaml');
    await writeFile(file, suite(url), 'utf8');
    const recordings = path.join(dir, 'recordings');
    await runCli(['run', file, '--out', path.join(dir, 'runs'), '--record', recordings]);
    expect((await readdir(recordings)).sort()).toEqual(['ab-candidate.json', 'ab-current.json']);
    await server!.close();
    server = undefined;
    expect(await runCli(['run', file, '--out', path.join(dir, 'runs'), '--replay', recordings])).toBe(1);
    expect(output).toContain('candidate vs current: 1 worse (second)');
  });
});
