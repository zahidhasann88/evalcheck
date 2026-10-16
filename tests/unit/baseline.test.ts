import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  baselineFilePath,
  listBaselines,
  loadBaseline,
  resolveBaselinePath,
  saveBaseline,
} from '../../src/core/baseline.js';

const fixture = path.resolve(import.meta.dirname, '../fixtures/run-a.json');

describe('baselines', () => {
  it('copies a run file into the baseline directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-baseline-'));
    const saved = await saveBaseline(fixture, { dir });
    expect(saved.path).toBe(baselineFilePath(dir, 'baseline'));
    expect(saved.run.meta.suiteName).toBe('fixture-suite');
    const content = await readFile(saved.path, 'utf8');
    expect(JSON.parse(content).cases).toHaveLength(4);
  });

  it('uses a custom name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-baseline-'));
    const saved = await saveBaseline(fixture, { dir, name: 'nightly' });
    expect(saved.path.endsWith('nightly.json')).toBe(true);
  });

  it('loads a stored baseline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-baseline-'));
    await saveBaseline(fixture, { dir });
    const run = await loadBaseline(baselineFilePath(dir));
    expect(run.totals.cases).toBe(4);
  });

  it('loads a stored baseline by name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-baseline-'));
    await saveBaseline(fixture, { dir, name: 'nightly' });
    const run = await loadBaseline('nightly', dir);
    expect(run.totals.cases).toBe(4);
  });

  it('prefers an existing file over a baseline name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-baseline-'));
    expect(await resolveBaselinePath(fixture, dir)).toBe(fixture);
    expect(await resolveBaselinePath('baseline', dir)).toBe(baselineFilePath(dir, 'baseline'));
    expect(await resolveBaselinePath('runs/missing.json', dir)).toBe(path.resolve('runs/missing.json'));
  });

  it('lists the stored baselines', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-baseline-'));
    await saveBaseline(fixture, { dir, name: 'a' });
    await saveBaseline(fixture, { dir, name: 'b' });
    const baselines = await listBaselines(dir);
    expect(baselines.map((b) => b.name)).toEqual(['a', 'b']);
  });

  it('returns an empty list for a missing directory', async () => {
    const baselines = await listBaselines('/tmp/evalcheck-does-not-exist-xyz');
    expect(baselines).toEqual([]);
  });

  it('reports a missing run file', async () => {
    await expect(saveBaseline('/tmp/evalcheck-missing-run.json')).rejects.toThrow(/Cannot read run file/);
  });
});
