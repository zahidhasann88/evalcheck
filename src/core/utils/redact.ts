/**
 * Combines literal secret values (from the environment) with well-known credential
 * patterns, so keys are hidden even when they were never seen as an env value.
 */

import { REDACTION_PLACEHOLDER } from './interpolate.js';

/**
 * Credential shapes. `maskGroup` is the 1-based index of the capture group
 * that has to be replaced with the placeholder (0 = replace the whole match).
 */
const VALUE_PATTERNS: Array<{ re: RegExp; maskGroup: number }> = [
  // Bearer / Basic authorization values
  { re: /(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{6,})/gi, maskGroup: 2 },
  // JSON style secrets
  {
    re: /("(?:api[_-]?key|apikey|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)"\s*:\s*")((?:\\.|[^"\\])*)(")/gi,
    maskGroup: 2,
  },
  // `KEY=value` pairs
  { re: /(\b[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=\s*)([^\s"'&,;]+)/g, maskGroup: 2 },
  // Common vendor key shapes
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, maskGroup: 0 },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b/g, maskGroup: 0 },
  { re: /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, maskGroup: 0 },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, maskGroup: 0 },
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, maskGroup: 0 },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, maskGroup: 0 },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, maskGroup: 0 },
  // PEM private keys
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, maskGroup: 0 },
];

export interface RedactorOptions {
  /** Literal secret values to hide. Short values are ignored (< 4 chars). */
  values?: Iterable<string>;
  /** Disable pattern based redaction (e.g. when a fixture intentionally contains a key). */
  patterns?: boolean;
}

/** Replaces every known secret with a stable placeholder. */
export function createRedactor(options: RedactorOptions = {}) {
  const values = [...(options.values ?? [])]
    .filter((v) => typeof v === 'string' && v.length >= 4)
    .sort((a, b) => b.length - a.length);
  const usePatterns = options.patterns !== false;

  const redactString = (input: string): string => {
    if (input.length === 0) return input;
    let out = input;
    for (const secret of values) {
      if (secret && out.includes(secret)) {
        out = out.split(secret).join(REDACTION_PLACEHOLDER);
      }
    }
    if (usePatterns) {
      for (const { re, maskGroup } of VALUE_PATTERNS) {
        re.lastIndex = 0;
        out = out.replace(re, (...args) => {
          const groups = args.slice(1, -2) as Array<string | undefined>;
          if (maskGroup === 0 || groups.length < maskGroup) return REDACTION_PLACEHOLDER;
          const before = groups.slice(0, maskGroup - 1).join('');
          const after = groups.slice(maskGroup).join('');
          return `${before}${REDACTION_PLACEHOLDER}${after}`;
        });
      }
    }
    return out;
  };

  const redactDeep = <T,>(value: T): T => {
    if (typeof value === 'string') return redactString(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redactDeep(v);
      }
      return out as unknown as T;
    }
    return value;
  };

  return { redactString, redactDeep };
}

export type Redactor = ReturnType<typeof createRedactor>;

/** Redacts header values whose name looks sensitive. */
export function redactHeaders(
  headers: Record<string, string>,
  redactor: Redactor,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(k)) {
      out[k] = REDACTION_PLACEHOLDER;
    } else {
      out[k] = redactor.redactString(v);
    }
  }
  return out;
}

const SENSITIVE_HEADER = /authorization|api[-_]?key|secret|token|password|passwd|cookie|set-cookie|auth/i;
