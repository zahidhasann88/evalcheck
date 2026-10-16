import { describe, expect, it } from 'vitest';

import {
  applyNormalizers,
  cardIssuer,
  countChars,
  countWords,
  jaccard,
  lexicalOverlap,
  luhnValid,
  rougeL,
  tokenF1,
  tokenize,
} from '../../src/core/utils/text.js';

describe('tokenization', () => {
  it('splits latin text', () => {
    expect(tokenize('Hello, brave new world!')).toEqual(['hello', 'brave', 'new', 'world']);
  });

  it('splits Bangla text into words', () => {
    const tokens = tokenize('ডেলিভারি সাধারণত ২-৩ কর্মদিবসে হয়');
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens).toContain('ডেলিভারি');
  });

  it('handles an empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('counts words and characters', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countChars('abc')).toBe(3);
    // Emoji are single code points but two UTF-16 units.
    expect(countChars('😀')).toBe(1);
  });
});

describe('normalizers', () => {
  it('applies the requested normalizers', () => {
    expect(applyNormalizers('  Hello   World  ', ['trim', 'lowercase', 'collapseWhitespace'])).toBe(
      'hello world',
    );
  });

  it('removes punctuation', () => {
    expect(applyNormalizers('Hello, world!', ['removePunctuation'])).toBe('Hello world');
  });

  it('returns the input unchanged for an empty list', () => {
    expect(applyNormalizers('  keep  ', [])).toBe('  keep  ');
  });
});

describe('lexical overlap', () => {
  it('computes a perfect F1 for identical texts', () => {
    const result = tokenF1(tokenize('a b c'), tokenize('a b c'));
    expect(result.f1).toBe(1);
  });

  it('computes a zero F1 for disjoint texts', () => {
    const result = tokenF1(tokenize('a b c'), tokenize('x y z'));
    expect(result.f1).toBe(0);
  });

  it('computes ROUGE-L using the longest common subsequence', () => {
    const result = rougeL(tokenize('a b c d'), tokenize('a x c d'));
    expect(result.overlap).toBe(3);
    expect(result.f1).toBeCloseTo(0.75, 5);
  });

  it('computes the Jaccard index', () => {
    const result = jaccard(tokenize('a b c'), tokenize('b c d'));
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  it('exposes a combined helper', () => {
    const result = lexicalOverlap('refunds within 30 days', 'Refunds within 30 days.', 'f1');
    expect(result.score).toBeCloseTo(1, 5);
    expect(result.metric).toBe('f1');
  });

  it('is case and punctuation insensitive', () => {
    const result = lexicalOverlap('Refunds within 30 days!', 'refunds within thirty days', 'f1');
    expect(result.score).toBeGreaterThan(0.4);
  });
});

describe('luhn', () => {
  it('accepts valid card numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111 1111 1111 1111')).toBe(true);
    expect(luhnValid('5500005555555559')).toBe(true);
    expect(luhnValid('378282246310005')).toBe(true);
  });

  it('rejects invalid card numbers', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('1234567890123456')).toBe(false);
  });

  it('rejects values that are not card numbers', () => {
    expect(luhnValid('1234')).toBe(false);
    expect(luhnValid('')).toBe(false);
    expect(luhnValid('abcd')).toBe(false);
  });

  it('detects the issuer', () => {
    expect(cardIssuer('4111111111111111')).toBe('visa');
    expect(cardIssuer('5500005555555559')).toBe('mastercard');
    expect(cardIssuer('378282246310005')).toBe('amex');
    expect(cardIssuer('9999999999999999')).toBeUndefined();
  });
});
