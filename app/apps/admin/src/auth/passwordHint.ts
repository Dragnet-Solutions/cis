/**
 * The set-password page's hint. Mirrors the server's policy
 * (@cis/domain password-policy: at least 12 characters, not your email, not
 * one character repeated) so the person sees a problem before submitting; the
 * server still decides. Pure — no DOM.
 */
export const MIN_PASSWORD_LENGTH = 12;

export type PasswordStrength = 'too-short' | 'weak' | 'fair' | 'strong';

export interface PasswordHint {
  /** Why the server would refuse it, or null when it would accept it. */
  problem: string | null;
  strength: PasswordStrength;
  label: string;
}

export function passwordHint(password: string, email: string): PasswordHint {
  const p = password.trim().toLowerCase();
  const e = email.trim().toLowerCase();
  const local = e.split('@')[0] ?? '';
  let problem: string | null = null;
  if (password.length < MIN_PASSWORD_LENGTH) {
    problem = `Use at least ${MIN_PASSWORD_LENGTH} characters (${password.length} so far).`;
  } else if (p === e || (local.length > 0 && p === local)) {
    problem = 'Do not use your email address.';
  } else if (new Set(password).size === 1) {
    problem = 'Do not repeat one character.';
  }
  if (problem && password.length < MIN_PASSWORD_LENGTH) {
    return { problem, strength: 'too-short', label: 'Too short' };
  }
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  const strength: PasswordStrength = problem
    ? 'weak'
    : password.length >= 20 || (password.length >= 14 && kinds >= 3)
      ? 'strong'
      : kinds >= 2
        ? 'fair'
        : 'weak';
  const label = { 'too-short': 'Too short', weak: 'Weak', fair: 'Fair', strong: 'Strong' }[
    strength
  ];
  return { problem, strength, label };
}
