import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadDataset, parseCsv } from '../../src/core/config/dataset.js';

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'evalcheck-ds-'));
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf8');
  return file;
}

describe('csv parsing', () => {
  it('parses quoted fields', () => {
    const rows = parseCsv('a,b\n"1,2","x"\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1,2', 'x'],
    ]);
  });

  it('handles escaped quotes and CRLF', () => {
    const rows = parseCsv('a,b\r\n"say ""hi""",2\r\n');
    expect(rows[1]).toEqual(['say "hi"', '2']);
  });

  it('handles empty lines', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toHaveLength(2);
  });
});

describe('datasets', () => {
  it('loads a JSONL file', async () => {
    const file = await tempFile(
      'cases.jsonl',
      [
        JSON.stringify({ id: 'a', input: 'first', user: 'u1' }),
        JSON.stringify({ id: 'b', input: 'second', user: 'u2' }),
      ].join('\n'),
    );
    const dataset = await loadDataset(file);
    expect(dataset.cases).toHaveLength(2);
    expect(dataset.cases[0]).toMatchObject({ id: 'a', input: 'first' });
    expect(dataset.cases[0]!.vars).toEqual({ user: 'u1' });
  });

  it('loads a CSV file and maps the columns', async () => {
    const file = await tempFile('cases.csv', 'key,question,lang\na,What is it?,en\nb,এটি কী?,bn\n');
    const dataset = await loadDataset(file, { idColumn: 'key', inputColumn: 'question' });
    expect(dataset.cases).toHaveLength(2);
    expect(dataset.cases[0]!.id).toBe('a');
    expect(dataset.cases[0]!.input).toBe('What is it?');
    expect(dataset.cases[0]!.vars).toEqual({ lang: 'en' });
  });

  it('maps only the requested var columns', async () => {
    const file = await tempFile('cases.csv', 'id,input,lang,other\na,q,en,ignored\n');
    const dataset = await loadDataset(file, { varsColumns: ['lang'] });
    expect(dataset.cases[0]!.vars).toEqual({ lang: 'en' });
  });

  it('reads per row checks from a JSON column', async () => {
    const file = await tempFile(
      'cases.jsonl',
      JSON.stringify({
        id: 'a',
        input: 'x',
        checks: [{ type: 'contains', value: 'ok' }],
      }),
    );
    const dataset = await loadDataset(file, { checksColumn: 'checks' });
    expect(dataset.cases[0]!.checks).toHaveLength(1);
  });

  it('reads tags from a comma separated column', async () => {
    const file = await tempFile('cases.csv', 'id,input,tags\na,q,billing;refunds\n');
    const dataset = await loadDataset(file, { tagsColumn: 'tags' });
    expect(dataset.cases[0]!.tags).toEqual(['billing', 'refunds']);
  });

  it('rejects rows without an id', async () => {
    const file = await tempFile('cases.csv', 'id,input\n,q\n');
    await expect(loadDataset(file)).rejects.toThrow(/missing the id column/);
  });

  it('rejects invalid JSONL with a line number', async () => {
    const file = await tempFile('cases.jsonl', '{"id":"a"}\nnot json\n');
    await expect(loadDataset(file)).rejects.toMatchObject({
      details: [expect.stringContaining('line 2')],
    });
  });

  it('rejects unsupported formats', async () => {
    const file = await tempFile('cases.txt', 'hello');
    await expect(loadDataset(file)).rejects.toThrow(/Unsupported dataset format/);
  });
});
