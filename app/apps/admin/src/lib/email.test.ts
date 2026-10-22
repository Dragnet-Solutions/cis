/**
 * The client-side email pre-check matches the server's rule exactly, so a
 * form never blocks an address the API would accept, nor lets through one it
 * would reject.
 */
import { describe, it, expect } from 'vitest';
import { EMAIL_INVALID_MESSAGE, EMAIL_PATTERN, emailFieldError, isValidEmail } from './email';

// The rule in packages/domain (invitations, people-access, firm-portal, journey).
const SERVER_RULE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

describe('isValidEmail', () => {
  it.each(['ada@example.com', 'a.b+c@sub.example.co.uk', 'x@y.z', '  ada@example.com  '])(
    'accepts %j',
    (v) => expect(isValidEmail(v)).toBe(true),
  );

  it.each([
    '',
    '   ',
    'ada',
    'ada@',
    '@example.com',
    'ada@example',
    'ada example@x.com',
    'ada@@example.com',
    'ada@exa mple.com',
  ])('rejects %j', (v) => expect(isValidEmail(v)).toBe(false));

  it('treats null and undefined as invalid', () => {
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
  });

  it('is the same pattern the server applies (after trimming)', () => {
    expect(EMAIL_PATTERN.source).toBe(SERVER_RULE.source);
    for (const v of ['a@b.c', 'a@b', 'a b@c.d', 'x@y.co']) {
      expect(isValidEmail(v)).toBe(SERVER_RULE.test(v));
    }
  });
});

describe('emailFieldError', () => {
  it('says nothing until the field has been left or a submit tried', () => {
    expect(emailFieldError('nope', false)).toBeNull();
  });

  it('says nothing for an empty field', () => {
    expect(emailFieldError('', true)).toBeNull();
    expect(emailFieldError('  ', true)).toBeNull();
  });

  it('explains an address that will not be accepted', () => {
    expect(emailFieldError('nope', true)).toBe(EMAIL_INVALID_MESSAGE);
  });

  it('clears once the address is valid', () => {
    expect(emailFieldError('ada@example.com', true)).toBeNull();
  });
});
