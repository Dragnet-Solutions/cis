import { getCanonical } from './answer';
import type { SurveyItem } from './types';

/**
 * The scope-gate route, shared by the respondent renderer, the server's
 * draft/submit checks and the respondent robot, so all three agree on exactly
 * which items a journey contains.
 *
 * A gate is an ordinary `single` item that declares `scopeGate.closeOn` in the
 * Register. Answered with one of those options, the instrument closes at that
 * item: nothing after it is presented, required, or recorded, and the response
 * is complete as it stands.
 */

/** Whether this item, with this stored value, closes the instrument. */
export function closesScope(item: SurveyItem, value: unknown): boolean {
  const gate = item.scopeGate;
  if (!gate || gate.closeOn.length === 0) return false;
  const a = getCanonical(value).a;
  return typeof a === 'string' && gate.closeOn.includes(a);
}

/** The outcome of applying every scope gate to a journey's steps. */
export interface ScopeGatedSteps<T> {
  /** The steps the journey actually contains: everything up to and including
   *  a closing gate, or every step when no gate has closed. */
  steps: T[];
  /** Index (in the input) of the gate that closed the instrument, or null. */
  closedAt: number | null;
}

/**
 * Cut a journey's steps at the first gate whose current answer closes the
 * instrument. `valueOf` reads the saved/current answer for a step.
 */
export function applyScopeGate<T extends { item: SurveyItem }>(
  steps: T[],
  valueOf: (step: T) => unknown,
): ScopeGatedSteps<T> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (closesScope(step.item, valueOf(step))) {
      return { steps: steps.slice(0, i + 1), closedAt: i };
    }
  }
  return { steps, closedAt: null };
}
