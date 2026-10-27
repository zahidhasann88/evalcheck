import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli/index.js';
import { loadSuite } from '../../src/core/config/loader.js';
import { applySharedConfig, expandSuitePaths } from '../../src/core/config/shared.js';
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

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-multi-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function suite(name: string, value: string): string {
  return `name: ${name}\ncases:\n  - id: a\n    input: hi\n    checks:\n      - type: contains\n        value: ${value}\n`;
}

async function startServer(): Promise<string> {
  server = await startTestServer((req, res) => {
    jsonResponse(res, 200, { reply: `pong ${req.headers['x-team'] ?? ''}` });
  });
  return server.url;
}

describe('shared config', () => {
  it('merges the shared target and defaults into every suite', () => {
    const merged = applySharedConfig(
      {
        path: '/x/evalcheck.config.yaml',
        raw: {
          target: { url: 'http://shared', headers: { a: '1', b: '1' }, response: { textPath: '$.reply' } },
          defaults: { repeat: 2, vars: { x: 1 }, checks: [{ type: 'latency', maxMs: 100 }] },
        },
      },
      {
        name: 's',
        target: { headers: { b: '2' } },
        defaults: { vars: { y: 2 }, checks: [{ type: 'contains', value: 'z' }] },
      },
    );
    expect(merged).toEqual({
      name: 's',
      target: { url: 'http://shared', headers: { a: '1', b: '2' }, response: { textPath: '$.reply' } },
      defaults: {
        repeat: 2,
        vars: { x: 1, y: 2 },
        checks: [
          { type: 'latency', maxMs: 100 },
          { type: 'contains', value: 'z' },
        ],
      },
    });
  });

  it('is found next to the suite and can be disabled or replaced', async () => {
    const dir = await project({
      'evalcheck.config.yaml': 'target:\n  url: http://from-config\n',
      'other.yaml': 'target:\n  url: http://from-other\n',
      'a.yaml': suite('a', 'x'),
    });
    const loaded = await loadSuite(path.join(dir, 'a.yaml'));
    expect(loaded.suite.target.url).toBe('http://from-config');
    expect(loaded.configPath).toBe(path.join(dir, 'evalcheck.config.yaml'));
    expect((await loadSuite(path.join(dir, 'a.yaml'), { config: path.join(dir, 'other.yaml') })).suite.target.url).toBe(
      'http://from-other',
    );
    await expect(loadSuite(path.join(dir, 'a.yaml'), { config: false })).rejects.toThrow(/Invalid suite file/);
  });

  it('resolves paths in the config relative to the config file', async () => {
    const dir = await project({
      'shared/evalcheck.config.yaml':
        'target:\n  url: http://x\ndefaults:\n  checks:\n    - type: custom\n      module: ./checks/c.mjs\n',
      'suites/a.yaml': suite('a', 'x'),
    });
    const loaded = await loadSuite(path.join(dir, 'suites/a.yaml'), { config: path.join(dir, 'shared/evalcheck.config.yaml') });
    const custom = loaded.suite.cases[0]!.checks!.find((c) => c.type === 'custom')!;
    expect(custom.type === 'custom' && custom.module).toBe(path.join(dir, 'shared', 'checks', 'c.mjs'));
  });

  it('reports invalid config files', async () => {
    const dir = await project({ 'evalcheck.config.yaml': 'target:\n  urll: x\n', 'a.yaml': suite('a', 'x') });
    await expect(loadSuite(path.join(dir, 'a.yaml'))).rejects.toThrow(/Invalid config file/);
  });

  it('expands directories into suite files without config files', async () => {
    const dir = await project({
      'evalcheck.config.yaml': 'target:\n  url: http://x\n',
      'b.yaml': suite('b', 'x'),
      'a.yml': suite('a', 'x'),
      'notes.txt': 'ignored',
    });
    expect(await expandSuitePaths([dir])).toEqual([path.join(dir, 'a.yml'), path.join(dir, 'b.yaml')]);
  });
});

describe('running several suites', () => {
  it('runs every suite in a directory with the shared config', async () => {
    const url = await startServer();
    const dir = await project({
      'suites/evalcheck.config.yaml': `target:\n  url: ${url}\n  headers:\n    x-team: support\n  response:\n    textPath: "$.reply"\n`,
      'suites/billing.yaml': suite('billing', 'support'),
      'suites/greeting.yaml': suite('greeting', 'missing'),
    });
    const out = path.join(dir, 'runs');
    const code = await runCli(['run', path.join(dir, 'suites'), '--out', out]);
    expect(code).toBe(1);
    expect(output).toContain('2 runs: 1 passed, 1 failed');
    expect((await readdir(out)).sort()).toEqual(['billing', 'greeting']);
    expect(await readdir(path.join(out, 'billing'))).toContain('latest.json');
  });

  it('writes one Markdown report per suite and a JSON array', async () => {
    const url = await startServer();
    const dir = await project({
      'evalcheck.config.yaml': `target:\n  url: ${url}\n  preset: generic-json\n  response:\n    textPath: "$.reply"\n`,
      'a.yaml': suite('a', 'pong'),
      'b.yaml': suite('b', 'pong'),
    });
    const report = path.join(dir, 'report.md');
    expect(await runCli(['run', path.join(dir, 'a.yaml'), path.join(dir, 'b.yaml'), '--out', path.join(dir, 'runs'), '--format', 'markdown', '--out-file', report])).toBe(0);
    const markdown = await readFile(report, 'utf8');
    expect(markdown).toContain('<!-- evalcheck:a -->');
    expect(markdown).toContain('<!-- evalcheck:b -->');

    expect(await runCli(['run', dir, '--out', path.join(dir, 'runs'), '--format', 'json'])).toBe(0);
    expect((JSON.parse(output) as unknown[]).length).toBe(2);
  });

  it('records and replays several suites through a directory', async () => {
    const url = await startServer();
    const dir = await project({
      'evalcheck.config.yaml': `target:\n  url: ${url}\n  response:\n    textPath: "$.reply"\n`,
      'a.yaml': suite('a', 'pong'),
      'b.yaml': suite('b', 'pong'),
    });
    const recordings = path.join(dir, 'recordings');
    expect(await runCli(['run', dir, '--out', path.join(dir, 'runs'), '--record', recordings])).toBe(0);
    expect((await readdir(recordings)).sort()).toEqual(['a.json', 'b.json']);
    await server!.close();
    server = undefined;
    expect(await runCli(['run', dir, '--out', path.join(dir, 'runs'), '--replay', recordings])).toBe(0);
  });

  it('rejects options that need a single suite and duplicate names', async () => {
    const dir = await project({
      'evalcheck.config.yaml': 'target:\n  url: http://127.0.0.1:9\n',
      'a.yaml': suite('same', 'x'),
      'b.yaml': suite('same', 'x'),
    });
    expect(await runCli(['run', dir, '--against', 'baseline'])).toBe(2);
    expect(await runCli(['run', dir])).toBe(2);
    expect(output).toContain('Two suites are named "same"');
  });

  it('validates every suite in a directory', async () => {
    const dir = await project({
      'evalcheck.config.yaml': 'target:\n  url: http://x\n',
      'a.yaml': suite('a', 'x'),
      'b.yaml': suite('b', 'x'),
    });
    expect(await runCli(['validate', dir])).toBe(0);
    expect(output.match(/is valid/g)).toHaveLength(2);
    expect(output).toContain('config     ');
  });
});
