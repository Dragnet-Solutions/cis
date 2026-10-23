/**
 * The one client-side email check, the same simple rule the API applies
 * (packages/domain: invitations, people-access, firm-portal, journey contact).
 * It only spares the person a round trip: the server still validates.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Surrounding spaces are ignored (and trimmed before sending). */
export const isValidEmail = (value: string | null | undefined): boolean =>
  EMAIL_PATTERN.test((value ?? '').trim());

export const EMAIL_INVALID_MESSAGE = 'Enter an email address in the format name@example.com.';

/**
 * The inline error to show, or null: nothing for an empty field (a required
 * field is held by its disabled submit button instead), and nothing until the
 * person has left the field or tried to submit.
 */
export function emailFieldError(value: string, shown: boolean): string | null {
  if (!shown || !value.trim()) return null;
  return isValidEmail(value) ? null : EMAIL_INVALID_MESSAGE;
}
