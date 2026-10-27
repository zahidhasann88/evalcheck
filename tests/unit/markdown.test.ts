import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { compareRuns } from '../../src/core/compare/compare.js';
import { parseRunFile } from '../../src/core/report/json.js';
import { markdownMarker, reportToMarkdown } from '../../src/core/report/markdown.js';
import type { RunResult } from '../../src/core/types.js';

const fixtureDir = path.resolve(import.meta.dirname, '../fixtures');

async function fixture(name: string): Promise<RunResult> {
  return parseRunFile(await readFile(path.join(fixtureDir, name), 'utf8'));
}

describe('markdown reporter', () => {
  it('starts with a marker so a PR comment can be updated in place', async () => {
    const markdown = reportToMarkdown(await fixture('run-a.json'));
    expect(markdown.split('\n')[0]).toBe(markdownMarker('fixture-suite'));
    expect(markdownMarker('my suite/v2')).toBe('<!-- evalcheck:my-suite-v2 -->');
  });

  it('summarises the run and lists failing cases with their reasons', async () => {
    const markdown = reportToMarkdown(await fixture('run-a.json'));
    expect(markdown).toContain('### ❌ evalcheck · fixture-suite');
    expect(markdown).toContain('| 4 | 3 | 1 | 0 | 0 | 75.0% |');
    expect(markdown).toContain('#### Failing cases (1)');
    expect(markdown).toContain('<code>shipping</code>');
    expect(markdown).not.toContain('<code>refund-policy</code>');
  });

  it('shows a passing run as green', async () => {
    const run = await fixture('run-a.json');
    run.cases = run.cases.filter((c) => c.status === 'passed');
    run.totals = { ...run.totals, failed: 0 };
    const markdown = reportToMarkdown(run);
    expect(markdown).toContain('### ✅ evalcheck');
    expect(markdown).not.toContain('Failing cases');
  });

  it('includes the comparison with regressions and fixes', async () => {
    const a = await fixture('run-a.json');
    const b = await fixture('run-b.json');
    b.comparison = compareRuns(a, b);
    const markdown = reportToMarkdown(b);
    expect(markdown).toContain('#### Compared with the baseline');
    expect(markdown).toContain('| Pass rate | 75.0% | 60.0% | -15.0 pp |');
    expect(markdown).toMatch(/- ❌ `refund-policy` \(passed → failed\)/);
    expect(markdown).toContain('- ✅ `shipping`');
    expect(markdown).toContain('**1** new');
  });

  it('keeps responses with backticks inside their code fence', async () => {
    const run = await fixture('run-a.json');
    const failing = run.cases.find((c) => c.status === 'failed')!;
    failing.attempts[0]!.text = 'here is code:\n```js\nx()\n```';
    const markdown = reportToMarkdown(run);
    expect(markdown).toContain('````text\nhere is code:\n```js\nx()\n```\n````');
  });

  it('limits the number of failing cases shown', async () => {
    const run = await fixture('run-a.json');
    const failing = run.cases.find((c) => c.status === 'failed')!;
    run.cases = Array.from({ length: 5 }, (_, i) => ({ ...failing, id: `case-${i}` }));
    const markdown = reportToMarkdown(run, { maxCases: 2 });
    expect(markdown.match(/<details>/g)).toHaveLength(2);
    expect(markdown).toContain('…and 3 more');
  });

  it('notes replayed runs', async () => {
    const run = await fixture('run-a.json');
    run.meta.replayed = true;
    expect(reportToMarkdown(run)).toContain('Graded from a recording');
  });
});
