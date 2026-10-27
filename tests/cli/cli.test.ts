import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli/index.js';
import { startMockServer } from '../../src/core/mock/server.js';
import { jsonResponse, startTestServer, type TestServer } from '../helpers/server.js';

let server: TestServer | undefined;
let originalExitCode: number | undefined;
/** Everything the last `runCli` call wrote to stdout and stderr. */
let output = '';

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

async function runCli(args: string[]): Promise<number> {
  originalExitCode = Number(process.exitCode ?? 0);
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
  output = writes.join('');
  return Number(process.exitCode ?? 0);
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'evalcheck-cli-'));
}

describe('evalcheck CLI', () => {
  it('validates a good suite and exits with 0', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'suite.yaml');
    await writeFile(
      file,
      `
name: good
target:
  url: http://127.0.0.1:9/chat
cases:
  - id: a
    input: hi
`,
      'utf8',
    );
    const code = await runCli(['validate', file]);
    expect(code).toBe(0);
  });

  it('exits with 2 for an invalid suite', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'broken.yaml');
    await writeFile(file, 'name: broken\ntarget:\n  method: POST\n', 'utf8');
    const code = await runCli(['validate', file]);
    expect(code).toBe(2);
  });

  it('exits with 1 when a check fails', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'completely different output' });
    });
    const dir = await tempDir();
    const file = path.join(dir, 'suite.yaml');
    await writeFile(
      file,
      `
name: failing
target:
  url: ${server.url}
  method: POST
  response:
    textPath: "$.reply"
cases:
  - id: a
    input: hi
    checks:
      - type: contains
        value: expected
`,
      'utf8',
    );
    const code = await runCli(['run', file, '--out', path.join(dir, 'runs')]);
    expect(code).toBe(1);
  });

  it('exits with 0 when every check passes', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'the expected text' });
    });
    const dir = await tempDir();
    const file = path.join(dir, 'suite.yaml');
    await writeFile(
      file,
      `
name: passing
target:
  url: ${server.url}
  method: POST
  response:
    textPath: "$.reply"
cases:
  - id: a
    input: hi
    checks:
      - type: contains
        value: expected
`,
      'utf8',
    );
    const code = await runCli(['run', file, '--out', path.join(dir, 'runs')]);
    expect(code).toBe(0);
  });

  it('exits with 3 when the endpoint is unreachable', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'suite.yaml');
    await writeFile(
      file,
      `
name: unreachable
target:
  url: http://127.0.0.1:1/chat
  method: POST
  timeoutMs: 500
cases:
  - id: a
    input: hi
`,
      'utf8',
    );
    const code = await runCli(['run', file, '--out', path.join(dir, 'runs')]);
    expect(code).toBe(3);
  });

  it('writes a JSON artifact next to the run', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'hello' });
    });
    const dir = await tempDir();
    const file = path.join(dir, 'suite.yaml');
    await writeFile(
      file,
      `
name: artifact
target:
  url: ${server.url}
  method: POST
  response:
    textPath: "$.reply"
cases:
  - id: a
    input: hi
`,
      'utf8',
    );
    const outDir = path.join(dir, 'runs');
    await runCli(['run', file, '--out', outDir]);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(outDir);
    const runFiles = files.filter((f) => f.endsWith('.json') && f !== 'latest.json');
    expect(runFiles).toHaveLength(1);
    expect(files).toContain('latest.json');
    const content = await readFile(path.join(outDir, runFiles[0]!), 'utf8');
    const parsed = JSON.parse(content) as { schemaVersion: string; meta: { suiteName: string } };
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.meta.suiteName).toBe('artifact');
    expect(await readFile(path.join(outDir, 'latest.json'), 'utf8')).toBe(content);
  });

  it('saves runs/latest.json as a baseline and shows it', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'pong' });
    });
    const dir = await tempDir();
    const file = path.join(dir, 'suite.yaml');
    await writeFile(
      file,
      `
name: baseline-flow
target:
  url: ${server.url}
  method: POST
cases:
  - id: a
    input: hi
`,
      'utf8',
    );
    const outDir = path.join(dir, 'runs');
    const baselineDir = path.join(dir, '.evalcheck');
    expect(await runCli(['run', file, '--out', outDir])).toBe(0);
    expect(await runCli(['baseline', 'save', path.join(outDir, 'latest.json'), '--dir', baselineDir])).toBe(0);
    expect(await runCli(['baseline', 'show', '--dir', baselineDir, '--no-color'])).toBe(0);
    expect(output).toContain('baseline-flow');
  });

  it('compares two runs and exits with 1 on regressions', async () => {
    const dir = await tempDir();
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    const base = {
      schemaVersion: '1.0',
      meta: {
        tool: { name: 'evalcheck', version: '0.1.0' },
        schemaVersion: '1.0',
        suiteName: 'x',
        suiteHash: 'sha256:abc',
        runId: 'r',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:00.000Z',
        durationMs: 1,
        node: 'v20',
        platform: 'linux',
      },
      totals: {
        cases: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        errored: 0,
        passRate: 1,
        checks: 1,
        checksPassed: 1,
        checksFailed: 0,
        requests: 1,
      },
    };
    const caseOk = {
      id: 'a',
      status: 'passed',
      passRate: 1,
      repeat: 1,
      tags: [],
      checks: [],
      attempts: [],
      latencyMs: { min: 1, max: 1, mean: 1, p50: 1, p95: 1 },
      durationMs: 1,
    };
    const caseBad = { ...caseOk, status: 'failed', passRate: 0 };
    await writeFile(a, JSON.stringify({ ...base, cases: [caseOk] }), 'utf8');
    await writeFile(
      b,
      JSON.stringify({
        ...base,
        meta: { ...base.meta, runId: 'r2' },
        totals: { ...base.totals, passed: 0, failed: 1, passRate: 0 },
        cases: [caseBad],
      }),
      'utf8',
    );

    const lenient = await runCli(['compare', a, b]);
    expect(lenient).toBe(0);

    const strict = await runCli(['compare', a, b, '--fail-on-regression']);
    expect(strict).toBe(1);

    const threshold = await runCli(['compare', a, b, '--threshold', 'pass_rate=-0.02']);
    expect(threshold).toBe(1);
  });

  it('generates a self-contained HTML report', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'hello world' });
    });
    const dir = await tempDir();
    const suiteFile = path.join(dir, 'suite.yaml');
    await writeFile(
      suiteFile,
      `
name: html
target:
  url: ${server.url}
  method: POST
  response:
    textPath: "$.reply"
cases:
  - id: a
    input: hi
    checks:
      - type: contains
        value: hello
`,
      'utf8',
    );
    const outDir = path.join(dir, 'runs');
    await runCli(['run', suiteFile, '--out', outDir]);
    const { readdir } = await import('node:fs/promises');
    const jsonFile = (await readdir(outDir)).find((f) => f.endsWith('.json'))!;
    const htmlFile = path.join(outDir, 'report.html');
    const code = await runCli(['report', path.join(outDir, jsonFile), '--format', 'html', '--out', htmlFile]);
    expect(code).toBe(0);
    const html = await readFile(htmlFile, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).toContain('hello world');
  });

  it('scaffolds an example suite with init', async () => {
    const dir = await tempDir();
    const code = await runCli(['init', dir]);
    expect(code).toBe(0);
    const suite = await readFile(path.join(dir, 'evalcheck.example.yaml'), 'utf8');
    expect(suite).toContain('name: example-support-bot');
    const check = await readFile(path.join(dir, 'checks', 'no-promo-code.mjs'), 'utf8');
    expect(check).toContain('export default');
  });

  it('the scaffolded example passes against the bundled mock endpoint', async () => {
    const mock = await startMockServer({ port: 0 });
    try {
      const dir = await tempDir();
      await runCli(['init', dir]);
      const suiteFile = path.join(dir, 'evalcheck.example.yaml');
      const suite = await readFile(suiteFile, 'utf8');
      await writeFile(suiteFile, suite.replace('http://127.0.0.1:8787', mock.url), 'utf8');
      expect(await runCli(['run', suiteFile, '--out', path.join(dir, 'runs')])).toBe(0);
    } finally {
      await mock.close();
    }
  });

  it('emits JUnit XML', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'hello' });
    });
    const dir = await tempDir();
    const suiteFile = path.join(dir, 'suite.yaml');
    await writeFile(
      suiteFile,
      `
name: junit
target:
  url: ${server.url}
  method: POST
  response:
    textPath: "$.reply"
cases:
  - id: a
    input: hi
    checks:
      - type: contains
        value: hello
`,
      'utf8',
    );
    const outDir = path.join(dir, 'runs');
    await runCli(['run', suiteFile, '--out', outDir]);
    const { readdir } = await import('node:fs/promises');
    const jsonFile = (await readdir(outDir)).find((f) => f.endsWith('.json'))!;
    await runCli(['report', path.join(outDir, jsonFile), '--format', 'junit', '--out', path.join(dir, 'junit.xml')]);
    const xml = await readFile(path.join(dir, 'junit.xml'), 'utf8');
    expect(xml).toContain('<testsuites');
    expect(xml).toContain('name="a"');
  });
  it('prints the suite JSON Schema and writes it to a file', async () => {
    const code = await runCli(['schema']);
    expect(code).toBe(0);
    expect(JSON.parse(output).title).toBe('evalcheck suite');

    const dir = await tempDir();
    const file = path.join(dir, 'suite.schema.json');
    expect(await runCli(['schema', '--out', file])).toBe(0);
    expect(JSON.parse(await readFile(file, 'utf8')).$schema).toBe('http://json-schema.org/draft-07/schema#');
  });

  it('records a run and replays it without the endpoint', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'the expected text' });
    });
    const dir = await tempDir();
    const file = path.join(dir, 'suite.yaml');
    await writeFile(
      file,
      `
name: recorded
target:
  url: ${server.url}
  response:
    textPath: "$.reply"
cases:
  - id: a
    input: hi
    checks:
      - type: contains
        value: expected
`,
      'utf8',
    );
    const recording = path.join(dir, 'recording.json');
    expect(await runCli(['run', file, '--out', path.join(dir, 'runs'), '--record', recording])).toBe(0);
    await server.close();
    server = undefined;

    expect(await runCli(['run', file, '--out', path.join(dir, 'runs'), '--replay', recording])).toBe(0);
    expect(output).toContain('replayed from a recording');

    expect(await runCli(['run', file, '--record', recording, '--replay', recording])).toBe(2);
  });

  it('writes a Markdown report', async () => {
    server = await startTestServer((_req, res) => {
      jsonResponse(res, 200, { reply: 'something else' });
    });
    const dir = await tempDir();
    const file = path.join(dir, 'suite.yaml');
    await writeFile(
      file,
      `
name: markdown
target:
  url: ${server.url}
  response:
    textPath: "$.reply"
cases:
  - id: a
    input: hi
    checks:
      - type: contains
        value: expected
`,
      'utf8',
    );
    const report = path.join(dir, 'report.md');
    const code = await runCli(['run', file, '--out', path.join(dir, 'runs'), '--format', 'markdown', '--out-file', report]);
    expect(code).toBe(1);
    const markdown = await readFile(report, 'utf8');
    expect(markdown).toContain('<!-- evalcheck:markdown -->');
    expect(markdown).toContain('<code>a</code>');

    process.exitCode = 0;
    expect(await runCli(['report', path.join(dir, 'runs', 'latest.json'), '--format', 'markdown'])).toBe(0);
    expect(output).toContain('### ❌ evalcheck · markdown');
  });
});
