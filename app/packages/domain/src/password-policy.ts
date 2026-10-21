/**
 * The operator password policy, shared by the set-password link and the
 * set-password CLI's minimum: at least 12 characters, not the person's own
 * email address (or its local part), not one character repeated, and not
 * longer than argon2 needs to hash sensibly. Pure — no I/O.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

export type PasswordProblem = 'too_short' | 'too_long' | 'is_email' | 'one_character';

const MESSAGES: Record<PasswordProblem, string> = {
  too_short: `The password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  too_long: `The password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
  is_email: 'The password must not be your email address.',
  one_character: 'The password must not be a single character repeated.',
};

/** The first problem with `password` for the person with `email`, or null. */
export function checkPasswordPolicy(
  password: string,
  email: string,
): { problem: PasswordProblem; message: string } | null {
  const problem = passwordProblem(password, email);
  return problem ? { problem, message: MESSAGES[problem] } : null;
}

function passwordProblem(password: string, email: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  const p = password.trim().toLowerCase();
  const e = email.trim().toLowerCase();
  const local = e.split('@')[0] ?? '';
  if (p === e || (local.length > 0 && p === local)) return 'is_email';
  if (new Set(password).size === 1) return 'one_character';
  return null;
}
