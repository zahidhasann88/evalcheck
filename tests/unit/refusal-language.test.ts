import { describe, expect, it } from 'vitest';

import { parseSuiteSource } from '../../src/core/config/loader.js';
import { detectLanguage, languageGrader } from '../../src/core/graders/language.js';
import { findRefusal, refusalGrader } from '../../src/core/graders/refusal.js';
import type { Check } from '../../src/core/types.js';
import { makeContext } from '../helpers/context.js';

describe('findRefusal', () => {
  it.each([
    "I'm sorry, but I can't help with that.",
    'I cannot provide medical advice.',
    'I am unable to assist with this request.',
    'Sorry, I won’t help with that.',
    'I must decline to answer.',
    'As an AI language model, I cannot browse the internet.',
    'That request goes against our policies.',
  ])('detects "%s"', (text) => {
    expect(findRefusal(text)).toBeDefined();
  });

  it.each([
    'Refunds are available within 30 days of purchase.',
    "I can help you reset your password.",
    "I'm unable to find order #1234, could you check the number?",
    'We cannot ship to PO boxes, but we can deliver to a pickup point.',
  ])('does not flag "%s"', (text) => {
    expect(findRefusal(text)).toBeUndefined();
  });

  it('accepts extra phrases', () => {
    expect(findRefusal('Please contact a human agent.', ['contact a human agent'])).toBe('contact a human agent');
  });
});

describe('refusal check', () => {
  const grade = (check: Partial<Extract<Check, { type: 'refusal' }>>, text: string) =>
    refusalGrader(makeContext({ check: { type: 'refusal', ...check }, text }));

  it('fails a refusal by default', async () => {
    const result = await grade({}, "I'm sorry, but I can't help with that.");
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(`the answer is a refusal ("I'm sorry, but I can't")`);
    expect((await grade({}, 'Refunds take 3 days.')).pass).toBe(true);
  });

  it('requires a refusal with refused: true', async () => {
    expect((await grade({ refused: true }, 'I cannot share other customers’ data.')).pass).toBe(true);
    const result = await grade({ refused: true }, 'Sure, here is their address.');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/^expected a refusal but the answer complies/);
  });
});

describe('detectLanguage', () => {
  it.each([
    ['en', 'Refunds are available within 30 days of purchase and you can track the order.'],
    ['de', 'Die Rückerstattung ist innerhalb von 30 Tagen möglich und wird nicht automatisch erstattet.'],
    ['fr', 'Le remboursement est possible pendant 30 jours et vous pouvez suivre la commande.'],
    ['es', 'El reembolso está disponible durante 30 días y puede seguir el pedido con el número.'],
    ['it', 'Il rimborso è disponibile per 30 giorni e non è necessario un account.'],
    ['pt', 'O reembolso está disponível por 30 dias e você pode acompanhar o pedido.'],
    ['nl', 'De terugbetaling is binnen 30 dagen mogelijk en het wordt niet automatisch verwerkt.'],
    ['ru', 'Возврат средств возможен в течение 30 дней.'],
    ['uk', 'Повернення коштів можливе протягом 30 днів і її підтверджує менеджер.'],
    ['el', 'Η επιστροφή χρημάτων είναι διαθέσιμη για 30 ημέρες.'],
    ['ar', 'يمكن استرداد الأموال خلال 30 يومًا.'],
    ['he', 'ניתן לקבל החזר כספי תוך 30 יום.'],
    ['hi', 'डिलीवरी में आमतौर पर 2-3 कार्यदिवस लगते हैं।'],
    ['th', 'คุณสามารถขอคืนเงินได้ภายใน 30 วัน'],
    ['ko', '구매 후 30일 이내에 환불받을 수 있습니다.'],
    ['ja', '購入後30日以内であれば返金できます。'],
    ['zh', '购买后三十天内可以退款。'],
  ])('detects %s', (language, text) => {
    expect(detectLanguage(text).language).toBe(language);
  });

  it('gives up on text without enough signal', () => {
    expect(detectLanguage('OK').language).toBeUndefined();
    expect(detectLanguage('12345 !!!').language).toBeUndefined();
  });
});

describe('language check', () => {
  const grade = (expected: string | string[], text: string) =>
    languageGrader(makeContext({ check: { type: 'language', expected }, text }));

  it('passes for an expected language and fails for another', async () => {
    expect((await grade('en', 'Refunds are available within 30 days of purchase.')).pass).toBe(true);
    expect((await grade(['de', 'en'], 'Die Rückerstattung ist innerhalb von 30 Tagen möglich.')).pass).toBe(true);
    const result = await grade('en', 'Le remboursement est possible pendant 30 jours et vous pouvez suivre la commande.');
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('expected en but the answer looks like fr');
  });

  it('fails when the language cannot be detected', async () => {
    expect((await grade('en', 'OK')).reason).toBe('could not detect the language of the answer (expected en)');
  });

  it('validates language codes in suites', () => {
    const source = (expected: string) =>
      `name: x\ntarget:\n  url: http://x\ncases:\n  - id: a\n    input: hi\n    checks:\n      - type: language\n        expected: ${expected}\n`;
    expect(() => parseSuiteSource(source('en'), '/tmp/suite.yaml')).not.toThrow();
    expect(() => parseSuiteSource(source('[en, de]'), '/tmp/suite.yaml')).not.toThrow();
    expect(() => parseSuiteSource(source('english'), '/tmp/suite.yaml')).toThrow(/Invalid suite file/);
  });
});
