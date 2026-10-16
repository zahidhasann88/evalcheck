import { describe, expect, it } from 'vitest';

import { jsonPathExists, jsonPathFirst, jsonPathQuery, parseJsonPath } from '../../src/core/utils/jsonpath.js';

const doc = {
  store: {
    book: [
      { title: 'Dune', price: 9.99, tags: ['scifi', 'classic'] },
      { title: 'Neuromancer', price: 12.5, tags: ['scifi'] },
    ],
    bicycle: { color: 'red', price: 19.95 },
  },
  'weird key': 42,
};

describe('jsonpath', () => {
  it('resolves a nested property', () => {
    expect(jsonPathFirst(doc, '$.store.bicycle.color')).toBe('red');
  });

  it('resolves array indexes', () => {
    expect(jsonPathFirst(doc, '$.store.book[0].title')).toBe('Dune');
  });

  it('resolves negative indexes', () => {
    expect(jsonPathFirst(doc, '$.store.book[-1].title')).toBe('Neuromancer');
  });

  it('resolves the wildcard', () => {
    const titles = jsonPathQuery(doc, '$.store.book[*].title');
    expect(titles).toEqual(['Dune', 'Neuromancer']);
  });

  it('supports quoted keys', () => {
    expect(jsonPathFirst(doc, "$['weird key']")).toBe(42);
  });

  it('supports recursive descent', () => {
    const prices = jsonPathQuery(doc, '$..price');
    expect(prices).toEqual([9.99, 12.5, 19.95]);
  });

  it('returns an empty list for missing paths', () => {
    expect(jsonPathQuery(doc, '$.store.nope')).toEqual([]);
    expect(jsonPathExists(doc, '$.store.nope')).toBe(false);
  });

  it('rejects paths that do not start with $', () => {
    expect(() => parseJsonPath('store.book')).toThrow(/must start with/);
  });

  it('rejects malformed paths', () => {
    expect(() => parseJsonPath('$.store[')).toThrow(/Unterminated/);
  });

  it('parses steps', () => {
    expect(parseJsonPath('$.a.b[0]')).toEqual([
      { kind: 'child', name: 'a' },
      { kind: 'child', name: 'b' },
      { kind: 'index', index: 0 },
    ]);
  });
});
