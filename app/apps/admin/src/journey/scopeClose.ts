import { closesScope, type SurveyItem } from '@cis/survey';
import { isAlreadySubmitted, type SavedAnswer } from './journeyClient';

/**
 * What the renderer does after a respondent's answer is saved (D-21):
 *
 *  - 'next'      — an ordinary answer: stay on the question, Next as usual;
 *  - 'thank-you' — a scope gate's closing answer (Q0 "Rare" / "Effectively
 *                  none") the server has already sent: straight to the
 *                  neutral thank-you, never to the question after it;
 *  - 'submit'    — a closing answer the server saved but did not send: send
 *                  it now (the ordinary submit), then the thank-you;
 *  - 'retry'     — the closing answer's save failed: stay, so it can be
 *                  answered again (the error is on screen).
 */
export type AfterSave = 'next' | 'thank-you' | 'submit' | 'retry';

export function afterSave(
  item: SurveyItem,
  answer: unknown,
  outcome: { saved: SavedAnswer | undefined } | { error: unknown },
): AfterSave {
  if (!closesScope(item, answer)) return 'next';
  if ('error' in outcome) return isAlreadySubmitted(outcome.error) ? 'thank-you' : 'retry';
  return outcome.saved?.submitted ? 'thank-you' : 'submit';
}
