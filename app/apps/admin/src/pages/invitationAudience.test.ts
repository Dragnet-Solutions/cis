/**
 * D-03: the manual "Retail survey reminder" reaches only unfinished
 * respondents, and the page shows that number — not everyone with a contact
 * detail.
 */
import { describe, it, expect } from 'vitest';
import { audienceReach, isSurveyReminder } from './invitationAudience';

const retail = {
  id: 'retail',
  label: 'Retail investors',
  sub: 'Those who gave a contact detail.',
  count: 40,
  unfinishedCount: 7,
};

describe('isSurveyReminder', () => {
  it('recognises the participant reminder template', () => {
    expect(isSurveyReminder({ name: 'Retail survey reminder', audienceKind: 'participant' })).toBe(
      true,
    );
  });
  it('leaves the invitation and firm templates alone', () => {
    expect(
      isSurveyReminder({ name: 'Retail survey invitation', audienceKind: 'participant' }),
    ).toBe(false);
    expect(isSurveyReminder({ name: 'Reminder', audienceKind: 'firm' })).toBe(false);
    expect(isSurveyReminder(null)).toBe(false);
  });
});

describe('audienceReach', () => {
  it('a reminder counts only those who have not finished', () => {
    expect(audienceReach(retail, true)).toBe(7);
  });
  it('any other template counts the whole audience', () => {
    expect(audienceReach(retail, false)).toBe(40);
  });
});
