import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { reportToConsole } from '../../src/core/report/console.js';
import { parseRunFile, reportToJson } from '../../src/core/report/json.js';
import { reportToJunit } from '../../src/core/report/junit.js';
import { reportToHtml, diffLines } from '../../src/core/report/html.js';
import type { RunResult } from '../../src/core/types.js';

const fixtureDir = path.resolve(import.meta.dirname, '../fixtures');

async function fixture(name: string): Promise<RunResult> {
  return parseRunFile(await readFile(path.join(fixtureDir, name), 'utf8'));
}

describe('json reporter', () => {
  it('emits a versioned document', async () => {
    const run = await fixture('run-a.json');
    const parsed = JSON.parse(reportToJson(run)) as RunResult;
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.meta.suiteName).toBe('fixture-suite');
    expect(parsed.cases).toHaveLength(4);
  });

  it('round trips through parseRunFile', async () => {
    const run = await fixture('run-a.json');
    const parsed = parseRunFile(reportToJson(run));
    expect(parsed.cases.map((c) => c.id)).toEqual(run.cases.map((c) => c.id));
  });

  it('rejects files that are not runs', () => {
    expect(() => parseRunFile('{"nope": true}')).toThrow(/missing "meta"/);
    expect(() => parseRunFile('not json')).toThrow(/Invalid JSON run file/);
  });
});

describe('junit reporter', () => {
  it('emits one testcase per case', async () => {
    const run = await fixture('run-a.json');
    const xml = reportToJunit(run);
    expect(xml).toContain('<testsuites');
    expect(xml).toContain('tests="4"');
    expect((xml.match(/<testcase /g) ?? [])).toHaveLength(4);
  });

  it('marks failing cases with a failure element', async () => {
    const run = await fixture('run-a.json');
    const xml = reportToJunit(run);
    expect(xml).toContain('<failure');
    expect(xml).toContain('shipping');
  });

  it('escapes XML special characters', async () => {
    const run = await fixture('run-a.json');
    run.cases[0]!.id = 'a<b&c"d';
    const xml = reportToJunit(run);
    expect(xml).toContain('a&lt;b&amp;c&quot;d');
  });
});

describe('console reporter', () => {
  it('summarises the run', async () => {
    const run = await fixture('run-a.json');
    const lines: string[] = [];
    const text = reportToConsole(run, { color: false, write: (line) => lines.push(line) });
    expect(text).toContain('evalcheck · fixture-suite');
    expect(text).toContain('cases 4');
    expect(text).toContain('passed 3');
    expect(text).toContain('failed 1');
    expect(text).toContain('per-check breakdown');
    expect(text).toContain('latency');
    expect(text).toContain('top failing reasons');
    expect(lines.join('\n')).toContain('evalcheck');
  });

  it('returns the report without writing to stdout', async () => {
    const run = await fixture('run-a.json');
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(reportToConsole(run, { color: false })).toContain('cases 4');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('lists flaky cases separately', async () => {
    const run = await fixture('run-a.json');
    run.cases[0]!.status = 'flaky';
    run.cases[0]!.passRate = 0.5;
    const text = reportToConsole(run, { color: false, write: () => {} });
    expect(text).toContain('flaky');
  });
});

describe('html reporter', () => {
  it('is a single self contained file', async () => {
    const run = await fixture('run-a.json');
    const html = reportToHtml(run);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    expect(html).not.toMatch(/https?:\/\/[^"']+\.(?:js|css)/i);
    expect(html).toContain('fixture-suite');
  });

  it('renders the case rows and the controls', async () => {
    const run = await fixture('run-a.json');
    const html = reportToHtml(run);
    expect(html).toContain('id="only-failing"');
    expect(html).toContain('id="search"');
    expect(html).toContain('data-sort="passrate"');
    expect(html).toContain('refund-policy');
  });

  it('renders the comparison section when one is present', async () => {
    const run = await fixture('run-b.json');
    const { compareRuns } = await import('../../src/core/compare/compare.js');
    const a = await fixture('run-a.json');
    run.comparison = compareRuns(a, run);
    const html = reportToHtml(run);
    expect(html).toContain('Comparison');
    expect(html).toContain('Regressions');
  });

  it('escapes HTML in the response text', async () => {
    const run = await fixture('run-a.json');
    run.cases[0]!.attempts[0]!.text = '<script>alert(1)</script>';
    const html = reportToHtml(run);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('diff', () => {
  it('marks added and removed lines', () => {
    const ops = diffLines(['a', 'b'], ['a', 'c']);
    expect(ops.filter((o) => o.kind === 'same')).toHaveLength(1);
    expect(ops.filter((o) => o.kind === 'del')).toHaveLength(1);
    expect(ops.filter((o) => o.kind === 'add')).toHaveLength(1);
  });

  it('handles identical inputs', () => {
    const ops = diffLines(['a', 'b'], ['a', 'b']);
    expect(ops.every((o) => o.kind === 'same')).toBe(true);
  });
});
