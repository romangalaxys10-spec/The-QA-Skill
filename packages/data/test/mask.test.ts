import { describe, expect, it } from 'vitest';

import { MASK_PATTERNS, luhnValid, maskObject, maskValue } from '../src/index.js';

describe('maskValue — cards', () => {
  it('masks a Luhn-valid card keeping the last 4 digits', () => {
    expect(maskValue('4242 4242 4242 4242')).toBe('****-****-****-4242');
    expect(maskValue('4242424242424242')).toBe('****-****-****-4242');
    expect(maskValue('4242-4242-4242-4242')).toBe('****-****-****-4242');
  });

  it('masks 15-digit Luhn-valid cards in the group-of-four shape', () => {
    // 79927398713 is the classic Luhn worked example (11 digits) — extend to 15.
    expect(maskValue('378282246310005')).toBe('****-****-***-0005');
  });

  it('leaves Luhn-INVALID long digit strings unmasked (they are not cards)', () => {
    expect(maskValue('4242424242424241')).toBe('4242424242424241');
  });

  it('validates with the exported luhn helper', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(luhnValid('79927398713')).toBe(true);
  });
});

describe('maskValue — other PII shapes', () => {
  it('masks emails', () => {
    expect(maskValue('jane.doe+qa@example-corp.io')).toBe('[MASKED_EMAIL]');
  });

  it('masks SSN-like values', () => {
    expect(maskValue('123-45-6789')).toBe('[MASKED_SSN]');
  });

  it('masks long base64ish tokens', () => {
    expect(maskValue('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe('[MASKED_TOKEN]');
    expect(maskValue('sk-live-abcdef1234567890abcdef')).toBe('[MASKED_TOKEN]');
  });

  it('masks phone numbers but not calendar dates', () => {
    expect(maskValue('+1 (415) 555-0132')).toBe('[MASKED_PHONE]');
    expect(maskValue('415-555-0132')).toBe('[MASKED_PHONE]');
    expect(maskValue('2026-10-07')).toBe('2026-10-07');
  });

  it('leaves ordinary strings and already-masked values untouched', () => {
    expect(maskValue('plain order note')).toBe('plain order note');
    expect(maskValue('42')).toBe('42');
    expect(maskValue('[MASKED_EMAIL]')).toBe('[MASKED_EMAIL]');
    expect(maskValue('')).toBe('');
  });
});

describe('maskObject', () => {
  it('deep-masks nested values by pattern, preserving structure', () => {
    const input = {
      user: {
        name: 'Jane',
        contact: { email: 'jane@example.test', phone: '+1 (415) 555-0132' },
        tags: ['vip', '123-45-6789'],
        logins: 7,
        active: true,
      },
    };
    const masked = maskObject(input) as typeof input;
    expect(masked.user.name).toBe('Jane');
    expect(masked.user.contact.email).toBe('[MASKED_EMAIL]');
    expect(masked.user.contact.phone).toBe('[MASKED_PHONE]');
    expect(masked.user.tags[0]).toBe('vip');
    expect(masked.user.tags[1]).toBe('[MASKED_SSN]');
    expect(masked.user.logins).toBe(7);
    expect(masked.user.active).toBe(true);
  });

  it('masks by KEY hint even when the value matches no pattern', () => {
    const masked = maskObject({
      password: 'short',
      secret_token: 'abc',
      card_number: '1234', // too short to be a real card
      dob: '1990-05-01',
      notes: 'keep me',
    }) as Record<string, unknown>;
    expect(masked['password']).toBe('[MASKED_PASSWORD]');
    expect(masked['secret_token']).toBe('[MASKED_TOKEN]');
    expect(masked['card_number']).toBe('[MASKED_CARD]');
    expect(masked['dob']).toBe('[MASKED_DOB]');
    expect(masked['notes']).toBe('keep me');
  });

  it('still preserves the last 4 for key-hinted Luhn-valid cards', () => {
    const masked = maskObject({ card: '4242 4242 4242 4242' }) as Record<string, unknown>;
    expect(masked['card']).toBe('****-****-****-4242');
  });

  it('masks array elements and inherits the key hint into arrays', () => {
    const masked = maskObject({ emails: ['a@example.test', 'not-an-email'] }) as Record<string, unknown[]>;
    // The KEY hint ('emails' ~ /email/i) masks every string element, pattern or not.
    expect(masked['emails']).toEqual(['[MASKED_EMAIL]', '[MASKED_EMAIL]']);
  });

  it('never rewrites keys, only values', () => {
    const masked = maskObject({ email_address: 'x@y.test', phoneNumber: '415-555-0132' }) as Record<string, unknown>;
    expect(Object.keys(masked).sort()).toEqual(['email_address', 'phoneNumber'].sort());
    expect(masked['email_address']).toBe('[MASKED_EMAIL]');
    expect(masked['phoneNumber']).toBe('[MASKED_PHONE]');
  });

  it('handles null and nested arrays of objects', () => {
    const masked = maskObject({ a: null, b: [{ ssn: '987-65-4321' }] }) as Record<string, unknown>;
    expect(masked['a']).toBeNull();
    const arr = masked['b'] as Array<{ ssn: string }>;
    expect(arr[0]?.ssn).toBe('[MASKED_SSN]');
  });
});

describe('MASK_PATTERNS (documentation export)', () => {
  it('documents every detection shape in evaluation order', () => {
    expect(MASK_PATTERNS.map((p) => p.name)).toEqual(['email', 'ssn', 'card', 'phone', 'token']);
    for (const pattern of MASK_PATTERNS) {
      expect(pattern.pattern).toBeInstanceOf(RegExp);
      expect(pattern.note.length).toBeGreaterThan(0);
    }
  });
});
