import { describe, expect, it } from 'vitest';

import {
  containsGrader,
  exactGrader,
  lengthGrader,
  notContainsGrader,
  regexGrader,
} from '../../src/core/graders/text.js';
import { jsonPathGrader } from '../../src/core/graders/json-path.js';
import { jsonSchemaGrader } from '../../src/core/graders/json-schema.js';
import { latencyGrader } from '../../src/core/graders/latency.js';
import { lexicalOverlapGrader } from '../../src/core/graders/lexical.js';
import { noPiiGrader, detectPii } from '../../src/core/graders/pii.js';
import { similarityGrader } from '../../src/core/graders/similarity.js';
import { makeContext, fakeEmbeddings } from '../helpers/context.js';

describe('contains / not_contains', () => {
  it('detects a required phrase', async () => {
    const result = await containsGrader(
      makeContext({ check: { type: 'contains', value: 'refund' }, text: 'Our refund policy' }),
    );
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails when the phrase is missing', async () => {
    const result = await containsGrader(
      makeContext({ check: { type: 'contains', value: 'refund' }, text: 'Our shipping policy' }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('does not contain');
  });

  it('is case sensitive by default and case insensitive on request', async () => {
    const sensitive = await containsGrader(
      makeContext({ check: { type: 'contains', value: 'Refund' }, text: 'refund policy' }),
    );
    expect(sensitive.pass).toBe(false);

    const insensitive = await containsGrader(
      makeContext({ check: { type: 'contains', value: 'Refund', caseInsensitive: true }, text: 'refund policy' }),
    );
    expect(insensitive.pass).toBe(true);
  });

  it('handles unicode text in other scripts', async () => {
    const result = await containsGrader(
      makeContext({ check: { type: 'contains', value: 'डिलीवरी' }, text: 'डिलीवरी में आमतौर पर 2-3 कार्यदिवस लगते हैं।' }),
    );
    expect(result.pass).toBe(true);
  });

  it('rejects a forbidden phrase', async () => {
    const result = await notContainsGrader(
      makeContext({ check: { type: 'not_contains', value: 'guarantee' }, text: 'We cannot guarantee delivery' }),
    );
    expect(result.pass).toBe(false);
  });

  it('passes when the forbidden phrase is absent', async () => {
    const result = await notContainsGrader(
      makeContext({ check: { type: 'not_contains', value: 'guarantee' }, text: 'Delivery usually takes 3 days' }),
    );
    expect(result.pass).toBe(true);
  });
});

describe('regex', () => {
  it('matches with flags', async () => {
    const result = await regexGrader(
      makeContext({ check: { type: 'regex', pattern: 'refund', flags: 'i' }, text: 'REFUND policy' }),
    );
    expect(result.pass).toBe(true);
  });

  it('fails when there is no match', async () => {
    const result = await regexGrader(
      makeContext({ check: { type: 'regex', pattern: '^\\d+$' }, text: 'not a number' }),
    );
    expect(result.pass).toBe(false);
  });

  it('reports invalid patterns instead of throwing', async () => {
    const result = await regexGrader(
      makeContext({ check: { type: 'regex', pattern: '([' }, text: 'anything' }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('invalid regular expression');
  });

  it('supports unicode flags', async () => {
    const result = await regexGrader(
      makeContext({ check: { type: 'regex', pattern: 'हिंदी', flags: 'u' }, text: 'मैं हिंदी बोलता हूँ' }),
    );
    expect(result.pass).toBe(true);
  });
});

describe('exact', () => {
  it('normalizes before comparing', async () => {
    const result = await exactGrader(
      makeContext({
        check: { type: 'exact', value: 'hello   world', normalize: ['trim', 'lowercase', 'collapseWhitespace'] },
        text: '  Hello World  ',
      }),
    );
    expect(result.pass).toBe(true);
  });

  it('fails for different text', async () => {
    const result = await exactGrader(
      makeContext({ check: { type: 'exact', value: 'hello', normalize: ['trim'] }, text: 'hello!' }),
    );
    expect(result.pass).toBe(false);
    expect(result.details).toMatchObject({ expected: 'hello', actual: 'hello!' });
  });

  it('handles an empty response', async () => {
    const result = await exactGrader(
      makeContext({ check: { type: 'exact', value: '', normalize: ['trim'] }, text: '' }),
    );
    expect(result.pass).toBe(true);
  });
});

describe('length', () => {
  it('counts characters', async () => {
    const result = await lengthGrader(
      makeContext({ check: { type: 'length', min: 3, max: 5 }, text: 'abcd' }),
    );
    expect(result.pass).toBe(true);
    expect(result.details).toMatchObject({ value: 4, unit: 'chars' });
  });

  it('fails when the text is too long', async () => {
    const result = await lengthGrader(
      makeContext({ check: { type: 'length', max: 3 }, text: 'abcdef' }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('above the maximum');
  });

  it('counts words in other scripts', async () => {
    const result = await lengthGrader(
      makeContext({ check: { type: 'length', min: 3, unit: 'words' }, text: 'डिलीवरी में आमतौर पर 2-3 कार्यदिवस लगते हैं' }),
    );
    expect(result.pass).toBe(true);
    expect(result.details).toMatchObject({ unit: 'words' });
  });

  it('treats an empty response as zero length', async () => {
    const result = await lengthGrader(makeContext({ check: { type: 'length', min: 1 }, text: '' }));
    expect(result.pass).toBe(false);
  });
});

describe('json_path', () => {
  const body = { choices: [{ message: { content: 'hi' } }], confidence: 0.9, tags: ['a', 'b'] };

  it('resolves nested paths', async () => {
    const result = await jsonPathGrader(
      makeContext({
        check: { type: 'json_path', path: '$.choices[0].message.content', equals: 'hi' },
        bodyJson: body,
      }),
    );
    expect(result.pass).toBe(true);
  });

  it('supports gte / lte', async () => {
    const pass1 = await jsonPathGrader(
      makeContext({ check: { type: 'json_path', path: '$.confidence', gte: 0.5 }, bodyJson: body }),
    );
    expect(pass1.pass).toBe(true);

    const fail1 = await jsonPathGrader(
      makeContext({ check: { type: 'json_path', path: '$.confidence', gte: 0.95 }, bodyJson: body }),
    );
    expect(fail1.pass).toBe(false);
  });

  it('supports exists', async () => {
    const result = await jsonPathGrader(
      makeContext({ check: { type: 'json_path', path: '$.missing', exists: false }, bodyJson: body }),
    );
    expect(result.pass).toBe(true);
  });

  it('supports matches and contains', async () => {
    const matched = await jsonPathGrader(
      makeContext({ check: { type: 'json_path', path: '$.tags', contains: 'a' }, bodyJson: body }),
    );
    expect(matched.pass).toBe(true);

    const regex = await jsonPathGrader(
      makeContext({ check: { type: 'json_path', path: '$.tags[0]', matches: '^a$' }, bodyJson: body }),
    );
    expect(regex.pass).toBe(true);
  });

  it('fails cleanly on malformed JSON', async () => {
    const result = await jsonPathGrader(
      makeContext({ check: { type: 'json_path', path: '$.a', exists: true }, text: 'not json' }),
    );
    expect(result.pass).toBe(false);
    expect(result.error).toBe('invalid-json');
  });

  it('reports invalid paths', async () => {
    const result = await jsonPathGrader(
      makeContext({ check: { type: 'json_path', path: 'choices[0]', exists: true }, bodyJson: body }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('invalid JSONPath');
  });

  it('requires at least one operator', async () => {
    const result = await jsonPathGrader(
      makeContext({ check: { type: 'json_path', path: '$.a' }, bodyJson: body }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('needs one of');
  });
});

describe('json_schema', () => {
  const schema = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string', minLength: 2 } },
  };

  it('accepts a valid document', async () => {
    const result = await jsonSchemaGrader(
      makeContext({ check: { type: 'json_schema', schema }, json: { answer: 'ok' } }),
    );
    expect(result.pass).toBe(true);
  });

  it('rejects an invalid document', async () => {
    const result = await jsonSchemaGrader(
      makeContext({ check: { type: 'json_schema', schema }, json: { answer: 42 } }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('does not match the JSON schema');
  });

  it('fails with a clear message on malformed JSON', async () => {
    const result = await jsonSchemaGrader(
      makeContext({ check: { type: 'json_schema', schema }, text: '{not json' }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('not valid JSON');
  });

  it('fails on an empty response', async () => {
    const result = await jsonSchemaGrader(
      makeContext({ check: { type: 'json_schema', schema }, text: '' }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('empty');
  });

  it('validates JSON that was extracted as a string', async () => {
    const result = await jsonSchemaGrader(
      makeContext({ check: { type: 'json_schema', schema }, json: '{"answer":"ok"}' }),
    );
    expect(result.pass).toBe(true);
  });
});

describe('latency', () => {
  it('accepts a response within the budget', async () => {
    const result = await latencyGrader(
      makeContext({ check: { type: 'latency', maxMs: 100 }, attempt: { latencyMs: 50 } }),
    );
    expect(result.pass).toBe(true);
  });

  it('rejects a response over the budget', async () => {
    const result = await latencyGrader(
      makeContext({ check: { type: 'latency', maxMs: 100 }, attempt: { latencyMs: 250 } }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('exceeds the budget');
  });

  it('checks the time to first token for streams', async () => {
    const ok = await latencyGrader(
      makeContext({ check: { type: 'latency', ttftMaxMs: 100 }, attempt: { latencyMs: 300, ttftMs: 50 } }),
    );
    expect(ok.pass).toBe(true);

    const slow = await latencyGrader(
      makeContext({ check: { type: 'latency', ttftMaxMs: 100 }, attempt: { latencyMs: 300, ttftMs: 250 } }),
    );
    expect(slow.pass).toBe(false);
    expect(slow.reason).toContain('time to first token');
  });

  it('explains that TTFT needs a streamed response', async () => {
    const result = await latencyGrader(
      makeContext({ check: { type: 'latency', ttftMaxMs: 100 }, attempt: { latencyMs: 20 } }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('was not measured');
  });
});

describe('lexical_overlap', () => {
  it('scores identical text at 1', async () => {
    const result = await lexicalOverlapGrader(
      makeContext({
        check: { type: 'lexical_overlap', reference: 'refunds are available within 30 days', minScore: 0.9 },
        text: 'Refunds are available within 30 days.',
      }),
    );
    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo(1, 2);
  });

  it('fails for unrelated text', async () => {
    const result = await lexicalOverlapGrader(
      makeContext({
        check: { type: 'lexical_overlap', reference: 'refunds are available within 30 days', minScore: 0.5 },
        text: 'the weather is nice today',
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBeLessThan(0.2);
  });

  it('supports several references and picks the best match', async () => {
    const result = await lexicalOverlapGrader(
      makeContext({
        check: {
          type: 'lexical_overlap',
          references: ['completely different words', 'shipping takes three days'],
          minScore: 0.4,
        },
        text: 'shipping takes three days',
      }),
    );
    expect(result.pass).toBe(true);
  });

  it('handles text in other scripts', async () => {
    const result = await lexicalOverlapGrader(
      makeContext({
        check: {
          type: 'lexical_overlap',
          reference: 'डिलीवरी में आमतौर पर 2-3 कार्यदिवस लगते हैं',
          minScore: 0.5,
        },
        text: 'डिलीवरी में आमतौर पर 2-3 कार्यदिवस लगते हैं।',
      }),
    );
    expect(result.pass).toBe(true);
  });

  it('requires a reference', async () => {
    const result = await lexicalOverlapGrader(
      makeContext({ check: { type: 'lexical_overlap' as never }, text: 'anything' }),
    );
    expect(result.pass).toBe(false);
  });
});

describe('no_pii', () => {
  it('detects an email address', () => {
    const findings = detectPii('Write to jane.doe@example.com for help');
    expect(findings.some((f) => f.category === 'email')).toBe(true);
  });

  it('detects a Luhn valid card number', () => {
    const findings = detectPii('card 4111 1111 1111 1111 expired');
    expect(findings.some((f) => f.category === 'card')).toBe(true);
  });

  it('ignores a Luhn invalid number', () => {
    const findings = detectPii('card 4111 1111 1111 1112 expired');
    expect(findings.some((f) => f.category === 'card')).toBe(false);
  });

  it('detects a phone number', () => {
    const findings = detectPii('call +880 1712 345678 now');
    expect(findings.some((f) => f.category === 'phone')).toBe(true);
  });

  it('detects a leaked API key', () => {
    const findings = detectPii('the key is sk-abcdef1234567890 do not share');
    expect(findings.some((f) => f.category === 'secret')).toBe(true);
  });

  it('fails the check when PII is present', async () => {
    const result = await noPiiGrader(
      makeContext({ check: { type: 'no_pii' }, text: 'email me at jane@example.com' }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('possible PII');
  });

  it('passes for clean text', async () => {
    const result = await noPiiGrader(
      makeContext({ check: { type: 'no_pii' }, text: 'Refunds are available within 30 days.' }),
    );
    expect(result.pass).toBe(true);
  });

  it('honours the allow list', async () => {
    const result = await noPiiGrader(
      makeContext({ check: { type: 'no_pii', allow: ['jane@example.com'] }, text: 'email jane@example.com' }),
    );
    expect(result.pass).toBe(true);
  });

  it('honours the category filter', async () => {
    const result = await noPiiGrader(
      makeContext({ check: { type: 'no_pii', categories: ['phone'] }, text: 'email jane@example.com' }),
    );
    expect(result.pass).toBe(true);
  });
});

describe('similarity', () => {
  it('uses the best matching reference', async () => {
    const embeddings = fakeEmbeddings({
      'the answer': [1, 0],
      'reference one': [1, 0],
      'reference two': [0, 1],
    });
    const result = await similarityGrader(
      makeContext({
        check: { type: 'similarity', references: ['reference one', 'reference two'], minScore: 0.9 },
        text: 'the answer',
        embeddings,
      }),
    );
    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo(1, 3);
  });

  it('fails when the score is below the threshold', async () => {
    const embeddings = fakeEmbeddings({ 'the answer': [1, 0], reference: [0, 1] });
    const result = await similarityGrader(
      makeContext({
        check: { type: 'similarity', reference: 'reference', minScore: 0.8 },
        text: 'the answer',
        embeddings,
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBeCloseTo(0, 3);
  });

  it('requires a reference', async () => {
    const result = await similarityGrader(
      makeContext({ check: { type: 'similarity' as never }, text: 'anything' }),
    );
    expect(result.pass).toBe(false);
  });
});
