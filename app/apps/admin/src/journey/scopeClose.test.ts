/**
 * D-21: the renderer's next move after an answer is saved. A scope gate's
 * closing answer (Q0 "Rare" / "Effectively none") goes to the thank-you —
 * never to the next question — however the save came back.
 */
import { describe, it, expect } from 'vitest';
import type { SurveyItem } from '@cis/survey';
import { afterSave } from './scopeClose';
import { JourneyApiError, type SavedAnswer } from './journeyClient';

const Q0: SurveyItem = {
  id: 'I-LCFE-Q0',
  kind: 'single',
  text: 'How often does your institution deal with stockbroking firms?',
  scope: 'shared',
  isDrgOps: false,
  scored: false,
  options: ['Regular and substantial', 'Occasional', 'Rare', 'Effectively none'],
  scopeGate: { closeOn: ['Rare', 'Effectively none'] },
};
const draft = { questionId: Q0.id, ratedFirmId: null, answer: { a: 'Rare' } };
const sent: SavedAnswer = { draft, closedByScopeGate: true, submitted: true };
const notSent: SavedAnswer = { draft, closedByScopeGate: true, submitted: false };

describe('afterSave — Q0 ends the survey on the answer', () => {
  for (const a of ['Rare', 'Effectively none']) {
    it(`"${a}", sent by the save: straight to the thank-you`, () => {
      expect(afterSave(Q0, { a }, { saved: sent })).toBe('thank-you');
    });
    it(`"${a}", saved but not sent: submit, then the thank-you`, () => {
      expect(afterSave(Q0, { a }, { saved: notSent })).toBe('submit');
    });
    it(`"${a}", already sent elsewhere: the thank-you, not an error`, () => {
      const error = new JourneyApiError(409, 'Already submitted', 'AlreadySubmittedError');
      expect(afterSave(Q0, { a }, { error })).toBe('thank-you');
    });
  }

  it('a failed save of a closing answer stays put so it can be retried', () => {
    expect(afterSave(Q0, { a: 'Rare' }, { error: new Error('offline') })).toBe('retry');
  });

  it('a non-closing answer carries on to the next question', () => {
    expect(afterSave(Q0, { a: 'Occasional' }, { saved: undefined })).toBe('next');
    expect(afterSave(Q0, { a: 'Regular and substantial' }, { saved: undefined })).toBe('next');
  });
});
