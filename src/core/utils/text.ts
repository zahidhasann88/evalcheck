// Intl.Segmenter gives proper word boundaries for scripts without simple spaces or with combining marks; the regex
// fallback covers Node builds without full ICU.

import type { Normalizer } from '../types.js';

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'word' })
    : null;

const FALLBACK_TOKEN = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  if (!text) return [];
  if (segmenter) {
    const out: string[] = [];
    for (const segment of segmenter.segment(text)) {
      if (segment.isWordLike) out.push(segment.segment.toLowerCase());
    }
    return out;
  }
  return text.toLowerCase().match(FALLBACK_TOKEN) ?? [];
}

/** Number of words in a text (Unicode aware). */
export function countWords(text: string): number {
  return tokenize(text).length;
}

/** Number of characters, counting Unicode code points (not UTF-16 units). */
export function countChars(text: string): number {
  return [...text].length;
}

export function applyNormalizers(text: string, normalizers: Normalizer[] = []): string {
  let out = text;
  for (const normalizer of normalizers) {
    switch (normalizer) {
      case 'trim':
        out = out.trim();
        break;
      case 'lowercase':
        out = out.toLowerCase();
        break;
      case 'uppercase':
        out = out.toUpperCase();
        break;
      case 'collapseWhitespace':
        out = out.replace(/\s+/gu, ' ');
        break;
      case 'removePunctuation':
        out = out.replace(/[\p{P}\p{S}]/gu, '');
        break;
      default:
        break;
    }
  }
  return out;
}

export interface LexicalOverlapResult {
  score: number;
  precision: number;
  recall: number;
  metric: 'f1' | 'rougeL' | 'jaccard';
  overlap: number;
  candidateTokens: number;
  referenceTokens: number;
}

/** Multiset (bag of words) F1 - the "token F1" style metric. */
export function tokenF1(candidate: string[], reference: string[]): {
  precision: number;
  recall: number;
  f1: number;
  overlap: number;
} {
  const candidateCounts = countMap(candidate);
  const referenceCounts = countMap(reference);
  let overlap = 0;
  for (const [token, count] of candidateCounts) {
    const refCount = referenceCounts.get(token);
    if (refCount) overlap += Math.min(count, refCount);
  }
  const precision = candidate.length === 0 ? 0 : overlap / candidate.length;
  const recall = reference.length === 0 ? 0 : overlap / reference.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, overlap };
}

/** Longest common subsequence based F1 (ROUGE-L style). */
export function rougeL(candidate: string[], reference: string[]): {
  precision: number;
  recall: number;
  f1: number;
  overlap: number;
} {
  const lcs = longestCommonSubsequence(candidate, reference);
  const precision = candidate.length === 0 ? 0 : lcs / candidate.length;
  const recall = reference.length === 0 ? 0 : lcs / reference.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, overlap: lcs };
}

/** Jaccard index over token sets. */
export function jaccard(candidate: string[], reference: string[]): {
  score: number;
  overlap: number;
} {
  const a = new Set(candidate);
  const b = new Set(reference);
  if (a.size === 0 && b.size === 0) return { score: 1, overlap: 0 };
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap++;
  const union = a.size + b.size - overlap;
  return { score: union === 0 ? 0 : overlap / union, overlap };
}

export function lexicalOverlap(
  candidateText: string,
  referenceText: string,
  metric: 'f1' | 'rougeL' | 'jaccard' = 'f1',
): LexicalOverlapResult {
  const candidate = tokenize(candidateText);
  const reference = tokenize(referenceText);
  if (metric === 'jaccard') {
    const { score, overlap } = jaccard(candidate, reference);
    return {
      score,
      precision: score,
      recall: score,
      metric,
      overlap,
      candidateTokens: candidate.length,
      referenceTokens: reference.length,
    };
  }
  const result = metric === 'rougeL' ? rougeL(candidate, reference) : tokenF1(candidate, reference);
  return {
    score: result.f1,
    precision: result.precision,
    recall: result.recall,
    metric,
    overlap: result.overlap,
    candidateTokens: candidate.length,
    referenceTokens: reference.length,
  };
}

function countMap(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

function longestCommonSubsequence(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]! + 1
          : Math.max(prev[j]!, curr[j - 1]!);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

export function luhnValid(digits: string): boolean {
  const cleaned = digits.replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(cleaned)) return false;
  let sum = 0;
  let double = false;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    let value = cleaned.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Coarse issuer detection used to enrich PII findings. */
export function cardIssuer(digits: string): string | undefined {
  const d = digits.replace(/[\s-]/g, '');
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^6(?:011|5)/.test(d)) return 'discover';
  if (/^(60|61|62)/.test(d)) return 'rupay';
  if (/^3(?:0[0-5]|[68])/.test(d)) return 'diners';
  return undefined;
}
