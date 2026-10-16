import { describe, expect, it } from 'vitest';

import { createInterpolator, interpolateEnv } from '../../src/core/utils/interpolate.js';

describe('environment interpolation', () => {
  it('substitutes environment variables', () => {
    const interpolator = createInterpolator({ env: { API_URL: 'https://api.example.com' } });
    expect(interpolator.string('${API_URL}/chat')).toBe('https://api.example.com/chat');
  });

  it('supports defaults with ${VAR:-default}', () => {
    const interpolator = createInterpolator({ env: {} });
    expect(interpolator.string('${MISSING:-fallback}')).toBe('fallback');
  });

  it('prefers the environment value over the default', () => {
    const interpolator = createInterpolator({ env: { PORT: '8080' } });
    expect(interpolator.string('${PORT:-3000}')).toBe('8080');
  });

  it('records substituted values as secrets', () => {
    const interpolator = createInterpolator({ env: { API_KEY: 'super-secret-value' } });
    interpolator.string('Bearer ${API_KEY}');
    expect(interpolator.secrets.has('super-secret-value')).toBe(true);
  });

  it('interpolates deeply nested structures', () => {
    const interpolator = createInterpolator({ env: { MODEL: 'gpt-4o-mini' } });
    const result = interpolator.deep({
      model: '${MODEL}',
      messages: [{ role: 'user', content: 'hello' }],
      nested: { deep: ['${MODEL}'] },
    });
    expect(result).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      nested: { deep: ['gpt-4o-mini'] },
    });
  });

  it('leaves non-string values untouched', () => {
    const interpolator = createInterpolator({ env: {} });
    expect(interpolator.deep({ a: 1, b: true, c: null })).toEqual({ a: 1, b: true, c: null });
  });

  it('exposes a process.env based helper', () => {
    expect(interpolateEnv('${NOPE:-fallback}', {})).toBe('fallback');
  });
});

describe('template interpolation', () => {
  const scope = {
    input: 'What is your refund policy?',
    vars: { user: 'u1', nested: { lang: 'bn' } },
    case: { id: 'refund-policy', tags: ['billing'] },
  };

  it('substitutes {{input}}', () => {
    const interpolator = createInterpolator({ env: {} });
    expect(interpolator.string('{{input}}', scope)).toBe('What is your refund policy?');
  });

  it('substitutes {{vars.x}}', () => {
    const interpolator = createInterpolator({ env: {} });
    expect(interpolator.string('{{vars.user}}', scope)).toBe('u1');
  });

  it('substitutes nested vars', () => {
    const interpolator = createInterpolator({ env: {} });
    expect(interpolator.string('{{vars.nested.lang}}', scope)).toBe('bn');
  });

  it('substitutes {{case.id}}', () => {
    const interpolator = createInterpolator({ env: {} });
    expect(interpolator.string('{{case.id}}', scope)).toBe('refund-policy');
  });

  it('renders objects as JSON', () => {
    const interpolator = createInterpolator({ env: {} });
    expect(interpolator.string('{{vars.nested}}', scope)).toBe('{"lang":"bn"}');
  });

  it('resolves unknown templates to an empty string', () => {
    const interpolator = createInterpolator({ env: {} });
    expect(interpolator.string('x{{vars.missing}}y', scope)).toBe('xy');
  });

  it('combines env vars and templates', () => {
    const interpolator = createInterpolator({ env: { BASE: 'https://api.test' } });
    const result = interpolator.string('${BASE}/cases/{{case.id}}?user={{vars.user}}', scope);
    expect(result).toBe('https://api.test/cases/refund-policy?user=u1');
  });
});
