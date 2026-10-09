import type { AnswerValue } from './types';

/**
 * Normalise any stored value into the canonical `{a, c}` envelope.
 *
 * Ported from UX-X-RENDER-001 R.get. A bare (non-enveloped) value is treated
 * as the answer with an empty comment; an existing envelope is preserved.
 */
export function getCanonical(value: unknown): { a: unknown; c: string } {
  if (value === undefined || value === null) {
    return { a: undefined, c: '' };
  }
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ('a' in (value as object) || 'c' in (value as object))
  ) {
    const v = value as AnswerValue;
    return { a: v.a, c: v.c ?? '' };
  }
  return { a: value, c: '' };
}

/** Build a canonical envelope, omitting an empty comment (R.put). */
export function putCanonical(a: unknown, c?: string): AnswerValue {
  return c ? { a, c } : { a };
}

/**
 * Set the answer half, preserving the current comment. This is the boundary
 * rule that prevented the "comment overwrote the answer" defect: the answer
 * writer reads the comment from the *current* value, never a captured one.
 */
export function setAnswer(prev: unknown, a: unknown): AnswerValue {
  return putCanonical(a, getCanonical(prev).c);
}

/** Set the comment half, preserving the current answer. */
export function setComment(prev: unknown, c: string): AnswerValue {
  return putCanonical(getCanonical(prev).a, c);
}
