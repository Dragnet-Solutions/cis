import { EMAIL_INVALID_MESSAGE, isValidEmail } from '../lib/email';

/** The same mobile rule the API applies to a contact number. */
const PHONE_PATTERN = /^\+?[0-9][0-9\s()-]{7,}$/;

/**
 * What is missing before a report-delivery choice can be saved, or null when
 * it can: a report by email needs an address, one by text a mobile number,
 * "no report" needs nothing (QA E14). The server checks the same.
 */
export function deliveryContactError(
  delivery: string,
  email: string,
  phone: string,
): string | null {
  if (delivery === 'email') {
    if (!email.trim()) return 'Enter the email address the report should go to.';
    if (!isValidEmail(email)) return EMAIL_INVALID_MESSAGE;
  }
  if (delivery === 'text') {
    if (!phone.trim()) return 'Enter the mobile number the report should go to.';
    if (!PHONE_PATTERN.test(phone.trim()))
      return 'Enter a mobile number, for example 0803 123 4567.';
  }
  return null;
}
