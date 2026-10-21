import { describe, it, expect } from 'vitest';
import { passwordHint } from './passwordHint';

describe('passwordHint', () => {
  const email = 'ada.okoro@cis.example';

  it('flags what the server would refuse', () => {
    expect(passwordHint('short', email)).toMatchObject({ strength: 'too-short' });
    expect(passwordHint('short', email).problem).toContain('12 characters');
    expect(passwordHint('ADA.OKORO@cis.example', email).problem).toBe(
      'Do not use your email address.',
    );
    expect(passwordHint('aaaaaaaaaaaaaaa', email).problem).toBe('Do not repeat one character.');
  });

  it('accepts a long passphrase and grades it', () => {
    expect(passwordHint('correct horse battery staple', email)).toEqual({
      problem: null,
      strength: 'strong',
      label: 'Strong',
    });
    expect(passwordHint('abcdefgh1234', email)).toMatchObject({ problem: null, strength: 'fair' });
    expect(passwordHint('abcdefghijkl', email)).toMatchObject({ problem: null, strength: 'weak' });
  });
});
