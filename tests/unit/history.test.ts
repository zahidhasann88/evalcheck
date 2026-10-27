import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli/index.js';
import { buildHistory, historyToConsole, historyToHtml, historyToMarkdown, trendSummary } from '../../src/core/report/history.js';
import { parseRunFile } from '../../src/core/report/json.js';
import type { RunResult } from '../../src/core/types.js';
import { jsonResponse, startTestServer, type TestServer } from '../helpers/server.js';

const fixture = path.resolve(import.meta.dirname, '../fixtures/run-a.json');

async function runAt(day: number, passRate: number, extra: Partial<RunResult['meta']> = {}): Promise<RunResult> {
  const run = parseRunFile(await readFile(fixture, 'utf8'));
  run.meta = { ...run.meta, runId: `run-${day}-${extra.variant ?? ''}`, startedAt: `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`, ...extra };
  run.totals = { ...run.totals, passRate };
  for (const attempt of run.cases.flatMap((c) => c.attempts)) attempt.usage = { totalTokens: 100 + day };
  return run;
}

describe('buildHistory', () => {
  it('groups runs by suite and variant, sorted by date', async () => {
    const runs = [await runAt(3, 0.5), await runAt(1, 1), await runAt(2, 0.75), await runAt(2, 1, { variant: 'candidate' })];
    const series = buildHistory(runs);
    expect(series.map((s) => [s.suiteName, s.variant, s.points.length])).toEqual([
      ['fixture-suite', undefined, 3],
      ['fixture-suite', 'candidate', 1],
    ]);
    expect(series[0]!.points.map((p) => p.passRate)).toEqual([1, 0.75, 0.5]);
    expect(series[0]!.points[0]!.tokensPerAttempt).toBe(101);
    expect(trendSummary(series[0]!)).toMatch(/^3 runs: pass rate 100\.0% → 50\.0%, p95 \d+ms → \d+ms, tokens 101 → 103$/);
  });

  it('filters by suite, keeps the latest runs and ignores duplicates', async () => {
    const runs = [await runAt(1, 1), await runAt(2, 1), await runAt(3, 1), await runAt(3, 1)];
    expect(buildHistory(runs, { limit: 2 })[0]!.points.map((p) => p.startedAt.slice(8, 10))).toEqual(['02', '03']);
    expect(buildHistory(runs, { suite: 'other' })).toEqual([]);
  });

  it('renders console, Markdown and HTML', async () => {
    const series = buildHistory([await runAt(1, 1, { tag: 'v1' }), await runAt(2, 0.5)]);
    expect(historyToConsole(series)).toMatch(/history · fixture-suite\ndate\s+pass rate\s+failed\s+p95\s+tokens\s+run/);
    expect(historyToConsole([])).toBe('no runs found\n');
    expect(historyToMarkdown(series)).toContain('| 2026-10-01 09:00 | 100.0% |');
    const html = historyToHtml(series);
    expect(html).toContain('<title>evalcheck history</title>');
    expect(html.match(/<polyline/g)).toHaveLength(3);
    expect(html).toContain('<td>v1</td>');
  });
});

describe('evalcheck history', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  async function cli(args: string[]): Promise<string> {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await main(['node', 'evalcheck', ...args]);
    vi.restoreAllMocks();
    return writes.join('');
  }

  it('reads every stored run and skips latest.json and other files', async () => {
    server = await startTestServer((_req, res) => jsonResponse(res, 200, { reply: 'pong' }));
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-history-'));
    const suite = path.join(dir, 'suite.yaml');
    await writeFile(suite, `name: trend\ntarget:\n  url: ${server.url}\n  preset: generic-json\n  response:\n    textPath: "$.reply"\ncases:\n  - id: a\n    input: hi\n`, 'utf8');
    const out = path.join(dir, 'runs');
    for (let i = 0; i < 3; i++) {
      await cli(['run', suite, '--out', out, '--quiet']);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await writeFile(path.join(out, 'notes.json'), '{"not": "a run"}', 'utf8');

    const text = await cli(['history', out]);
    expect(text).toContain('history · trend');
    expect(text).toContain('3 runs: pass rate 100.0% → 100.0%');

    const json = JSON.parse(await cli(['history', out, '--format', 'json', '--limit', '2'])) as Array<{ points: unknown[] }>;
    expect(json[0]!.points).toHaveLength(2);

    const file = path.join(dir, 'history.html');
    await cli(['history', out, '--format', 'html', '--out', file]);
    expect(await readFile(file, 'utf8')).toContain('<h2>trend</h2>');

    await cli(['history', out, '--limit', '0']);
    expect(process.exitCode).toBe(2);
  });
});
