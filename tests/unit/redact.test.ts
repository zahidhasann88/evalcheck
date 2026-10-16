import { describe, expect, it } from 'vitest';

import { createRedactor, redactHeaders } from '../../src/core/utils/redact.js';
import { REDACTION_PLACEHOLDER } from '../../src/core/utils/interpolate.js';

describe('redaction', () => {
  it('hides registered secret values', () => {
    const redactor = createRedactor({ values: ['super-secret-token'] });
    expect(redactor.redactString('token=super-secret-token')).toBe(`token=${REDACTION_PLACEHOLDER}`);
  });

  it('ignores very short values', () => {
    const redactor = createRedactor({ values: ['ab'] });
    expect(redactor.redactString('ab cd')).toBe('ab cd');
  });

  it('hides bearer tokens', () => {
    const redactor = createRedactor();
    const out = redactor.redactString('Authorization: Bearer abcdef1234567890');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it('hides API keys in JSON payloads', () => {
    const redactor = createRedactor();
    const out = redactor.redactString('{"api_key":"abcd1234efgh5678"}');
    expect(out).not.toContain('abcd1234efgh5678');
  });

  it('hides OpenAI style keys', () => {
    const redactor = createRedactor();
    expect(redactor.redactString('key sk-abcdef123456')).not.toContain('sk-abcdef123456');
  });

  it('hides JWTs', () => {
    const redactor = createRedactor();
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactor.redactString(`token ${jwt}`)).not.toContain(jwt);
  });

  it('redacts nested structures', () => {
    const redactor = createRedactor({ values: ['hunter2hunter2'] });
    const out = redactor.redactDeep({ a: { b: ['hunter2hunter2'] } });
    expect(JSON.stringify(out)).not.toContain('hunter2hunter2');
  });

  it('redacts sensitive headers entirely', () => {
    const redactor = createRedactor();
    const out = redactHeaders(
      { authorization: 'Bearer xyz', 'x-request-id': 'abc', 'x-api-key': 'k' },
      redactor,
    );
    expect(out.authorization).toBe(REDACTION_PLACEHOLDER);
    expect(out['x-api-key']).toBe(REDACTION_PLACEHOLDER);
    expect(out['x-request-id']).toBe('abc');
  });

  it('can be limited to explicit values only', () => {
    const redactor = createRedactor({ values: ['keepme'], patterns: false });
    expect(redactor.redactString('Bearer abcdef123456')).toBe('Bearer abcdef123456');
  });
});
