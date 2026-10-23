import { useState } from 'react';
import { emailFieldError, isValidEmail } from './email';

/**
 * Inline pre-validation for one email input. Spread `inputProps` on the input
 * and render `error` beneath it: the error is tied to the input by
 * aria-describedby and announced (role="alert") when it appears — after the
 * person leaves the field, or on `reveal()` when they try to submit. Use
 * `valid` to keep the submit button disabled until the address is usable.
 */
export function useEmailField(
  id: string,
  value: string,
  opts: { describedBy?: string } = {},
): {
  valid: boolean;
  inputProps: {
    id: string;
    onBlur: () => void;
    'aria-invalid': true | undefined;
    'aria-describedby': string | undefined;
  };
  error: JSX.Element | null;
  reveal: () => void;
} {
  const [shown, setShown] = useState(false);
  const message = emailFieldError(value, shown);
  const errorId = `${id}-error`;
  const describedBy = [opts.describedBy, message ? errorId : null].filter(Boolean).join(' ');
  return {
    valid: isValidEmail(value),
    inputProps: {
      id,
      onBlur: () => setShown(true),
      'aria-invalid': message ? true : undefined,
      'aria-describedby': describedBy || undefined,
    },
    error: message ? (
      <p id={errorId} className="field-error" role="alert">
        {message}
      </p>
    ) : null,
    reveal: () => setShown(true),
  };
}
