/**
 * @the-qa-skill/data — PII masking for test data and evidence.
 *
 * Every test answers three questions: where does its data come from (source),
 * who owns it (owner), and how is it cleaned up (cleanup). Masking is part of
 * that contract: realistic shapes, never real people. `maskValue` detects and
 * masks common PII shapes in strings; `maskObject` deep-walks structures and
 * also honors key-name hints.
 */

/** One documented detection pattern (exported for docs and tests). */
export interface MaskPattern {
  /** Stable name, e.g. 'email'. */
  name: string;
  /** Detection regex for the shape (applied to whole-string candidates). */
  pattern: RegExp;
  /** Human note about the replacement strategy. */
  note: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SSN_PATTERN = /^\d{3}-\d{2}-\d{4}$/;
/** Candidate card strings: digits with optional spaces/dashes, 13-19 digits. */
const CARD_CANDIDATE_PATTERN = /^\d[\d\s-]{12,34}$/;
/** Candidate phone strings: optional +, digits with common separators. */
const PHONE_CANDIDATE_PATTERN = /^\+?[\d\s().-]{7,20}$/;
/** Pure dates are NOT phone numbers even though they are digit-shaped. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Long base64ish tokens: JWTs, API keys, session ids. */
const TOKEN_PATTERN = /^[A-Za-z0-9_+=./-]{20,}$/;

/** The documented detection patterns, in evaluation order (card before phone). */
export const MASK_PATTERNS: readonly MaskPattern[] = [
  { name: 'email', pattern: EMAIL_PATTERN, note: 'replaced with [MASKED_EMAIL]' },
  { name: 'ssn', pattern: SSN_PATTERN, note: 'replaced with [MASKED_SSN]' },
  { name: 'card', pattern: CARD_CANDIDATE_PATTERN, note: 'Luhn-validated 13-19 digit card; keeps last 4' },
  { name: 'phone', pattern: PHONE_CANDIDATE_PATTERN, note: 'replaced with [MASKED_PHONE] (dates excluded)' },
  { name: 'token', pattern: TOKEN_PATTERN, note: '>=20 base64ish chars replaced with [MASKED_TOKEN]' },
];

/** Mask labels by key-name hint word (checked in this order). */
const KEY_HINTS: ReadonlyArray<{ word: string; label: string }> = [
  { word: 'email', label: 'EMAIL' },
  { word: 'phone', label: 'PHONE' },
  { word: 'card', label: 'CARD' },
  { word: 'ssn', label: 'SSN' },
  { word: 'token', label: 'TOKEN' },
  { word: 'secret', label: 'SECRET' },
  { word: 'password', label: 'PASSWORD' },
  { word: 'dob', label: 'DOB' },
];

const KEY_HINT_PATTERN = /email|phone|card|ssn|token|secret|password|dob/i;

/** Standard Luhn checksum over a digit string (used for card detection). */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = digits.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
    double = !double;
  }
  return sum % 10 === 0;
}

/** Extract only the digits of a string. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Mask a Luhn-valid card number, preserving the last 4 digits:
 * '****-****-****-1234' for 16-digit cards; shorter/longer cards keep the
 * group-of-four shape (e.g. 15-digit → '****-****-***-1234').
 */
function maskCard(digits: string): string {
  const last4 = digits.slice(-4);
  const remaining = digits.length - 4;
  const groups: string[] = [];
  let left = remaining;
  while (left > 0) {
    const size = Math.min(4, left);
    groups.push('*'.repeat(size));
    left -= size;
  }
  groups.push(last4);
  return groups.join('-');
}

/** Mask a value whose KEY matched the hint regex — pattern match not required. */
function maskForKey(key: string, value: string): string {
  const hint = KEY_HINTS.find((h) => key.toLowerCase().includes(h.word));
  const label = hint ? hint.label : 'MASKED';
  if (label === 'CARD') {
    const digits = digitsOf(value);
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return maskCard(digits);
    return '[MASKED_CARD]';
  }
  return `[MASKED_${label}]`;
}

/**
 * Mask a single string value by shape detection:
 *  - emails → '[MASKED_EMAIL]'
 *  - SSN-like (ddd-dd-dddd) → '[MASKED_SSN]'
 *  - Luhn-valid 13-19 digit cards (spaces/dashes allowed) → keep last 4
 *  - phones (7-15 digits with separators, dates excluded) → '[MASKED_PHONE]'
 *  - long base64ish tokens (>= 20 chars) → '[MASKED_TOKEN]'
 * Values matching no pattern are returned unchanged. Already-masked values
 * (e.g. '[MASKED_EMAIL]') are left as-is, so masking is idempotent.
 */
export function maskValue(value: string): string {
  if (EMAIL_PATTERN.test(value)) return '[MASKED_EMAIL]';
  if (SSN_PATTERN.test(value)) return '[MASKED_SSN]';
  const cardDigits = CARD_CANDIDATE_PATTERN.test(value) ? digitsOf(value) : '';
  if (cardDigits.length >= 13 && cardDigits.length <= 19 && luhnValid(cardDigits)) return maskCard(cardDigits);
  if (PHONE_CANDIDATE_PATTERN.test(value) && !DATE_PATTERN.test(value)) {
    const phoneDigits = digitsOf(value);
    if (phoneDigits.length >= 7 && phoneDigits.length <= 15) return '[MASKED_PHONE]';
  }
  if (TOKEN_PATTERN.test(value)) return '[MASKED_TOKEN]';
  return value;
}

/**
 * Deep-walk an unknown value and mask matching string VALUES only — keys are
 * never rewritten. Inside objects and arrays, a string whose key matches
 * /email|phone|card|ssn|token|secret|password|dob/i is masked based on the key
 * hint regardless of whether the value itself matches a detection pattern.
 * Cycles are handled: a repeated object reference is returned unchanged
 * (already walked). Non-string primitives pass through untouched.
 */
export function maskObject(obj: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, keyHint: string | undefined): unknown => {
    if (typeof value === 'string') {
      if (keyHint !== undefined && KEY_HINT_PATTERN.test(keyHint)) return maskForKey(keyHint, value);
      return maskValue(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, keyHint));
    }
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return value;
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        out[key] = walk(inner, key);
      }
      return out;
    }
    return value;
  };
  return walk(obj, undefined);
}
