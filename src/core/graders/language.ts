import type { Grader, LanguageCheck } from '../types.js';
import { fail, pass } from './helpers.js';

export interface LanguageDetection {
  /** ISO 639-1 code, or undefined when the language could not be determined. */
  language?: string;
  script: string;
  /** Share of known words (Latin script) or of letters in the detected script. */
  confidence: number;
}

const SCRIPTS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'Latin', pattern: /\p{Script=Latin}/u },
  { name: 'Cyrillic', pattern: /\p{Script=Cyrillic}/u },
  { name: 'Greek', pattern: /\p{Script=Greek}/u },
  { name: 'Arabic', pattern: /\p{Script=Arabic}/u },
  { name: 'Hebrew', pattern: /\p{Script=Hebrew}/u },
  { name: 'Devanagari', pattern: /\p{Script=Devanagari}/u },
  { name: 'Thai', pattern: /\p{Script=Thai}/u },
  { name: 'Hangul', pattern: /\p{Script=Hangul}/u },
  { name: 'Kana', pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
  { name: 'Han', pattern: /\p{Script=Han}/u },
];

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'are', 'of', 'to', 'in', 'that', 'it', 'you', 'for', 'with', 'this', 'was', 'not', 'be', 'have', 'your', 'can', 'will', 'we', 'our', 'or', 'within'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'es', 'un', 'una', 'por', 'para', 'con', 'no', 'su', 'se', 'del', 'al', 'está', 'como', 'pero'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'un', 'une', 'que', 'pour', 'pas', 'dans', 'vous', 'ce', 'il', 'sur', 'avec', 'du', 'au', 'nous', 'votre'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'mit', 'sie', 'es', 'ich', 'sich', 'auf', 'für', 'dem', 'auch', 'wird', 'ihre', 'innerhalb'],
  it: ['il', 'lo', 'gli', 'di', 'che', 'è', 'e', 'un', 'una', 'per', 'non', 'con', 'sono', 'del', 'della', 'si', 'ma', 'anche', 'nel', 'alla'],
  pt: ['o', 'os', 'as', 'de', 'que', 'e', 'é', 'um', 'uma', 'para', 'com', 'não', 'do', 'da', 'em', 'no', 'na', 'se', 'por', 'você', 'seu', 'sua'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'op', 'te', 'zijn', 'met', 'voor', 'je', 'ik', 'er', 'aan', 'ook', 'wordt', 'maar', 'uw', 'binnen'],
};

/** Deterministic language detection: the writing system first, then common words for Latin script. */
export function detectLanguage(text: string): LanguageDetection {
  const counts = new Map<string, number>();
  let letters = 0;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    letters++;
    const script = SCRIPTS.find((s) => s.pattern.test(char))?.name ?? 'Other';
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  if (letters === 0) return { script: 'None', confidence: 0 };

  if ((counts.get('Kana') ?? 0) > 0) {
    const japanese = (counts.get('Kana') ?? 0) + (counts.get('Han') ?? 0);
    return { language: 'ja', script: 'Kana', confidence: japanese / letters };
  }
  const [script, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const share = count / letters;
  switch (script) {
    case 'Latin':
      return detectLatin(text);
    case 'Cyrillic':
      return { language: /[іїєґ]/iu.test(text) ? 'uk' : 'ru', script, confidence: share };
    case 'Arabic':
      return { language: /[پچژگ]/u.test(text) ? 'fa' : 'ar', script, confidence: share };
    case 'Greek':
      return { language: 'el', script, confidence: share };
    case 'Hebrew':
      return { language: 'he', script, confidence: share };
    case 'Devanagari':
      return { language: 'hi', script, confidence: share };
    case 'Thai':
      return { language: 'th', script, confidence: share };
    case 'Hangul':
      return { language: 'ko', script, confidence: share };
    case 'Han':
      return { language: 'zh', script, confidence: share };
    default:
      return { script, confidence: 0 };
  }
}

function detectLatin(text: string): LanguageDetection {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let best: { language: string; hits: number } | undefined;
  let total = 0;
  for (const [language, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const hits = words.filter((word) => set.has(word)).length;
    total += hits;
    if (!best || hits > best.hits) best = { language, hits };
  }
  if (!best || best.hits < 2) return { script: 'Latin', confidence: 0 };
  return { language: best.language, script: 'Latin', confidence: best.hits / total };
}

export const languageGrader: Grader = (ctx) => {
  const check = ctx.check as LanguageCheck;
  const expected = (Array.isArray(check.expected) ? check.expected : [check.expected]).map((l) => l.toLowerCase());
  const detection = detectLanguage(ctx.text);
  const details = { ...detection, expected };
  if (!detection.language) {
    return fail(ctx, `could not detect the language of the answer (expected ${expected.join(' or ')})`, {
      score: 0,
      details,
    });
  }
  if (!expected.includes(detection.language)) {
    return fail(ctx, `expected ${expected.join(' or ')} but the answer looks like ${detection.language}`, {
      score: 0,
      details,
    });
  }
  return pass(ctx, `the answer is in ${detection.language}`, { score: 1, details });
};
