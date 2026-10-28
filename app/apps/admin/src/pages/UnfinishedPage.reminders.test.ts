/**
 * D-03 — what "Send reminders now" tells the operator: how many were sent,
 * and briefly why any were skipped.
 */
import { describe, it, expect } from 'vitest';
import type { ReminderRunResult } from '../api/types';
import { describeReminderRun } from './UnfinishedPage';

const base: ReminderRunResult = {
  collecting: true,
  emailed: 0,
  recorded: 0,
  notDue: 0,
  skipped: { notEmail: 0, noWording: 0, alreadySent: 0, noLongerEligible: 0 },
};

describe('describeReminderRun', () => {
  it('counts what was sent', () => {
    expect(describeReminderRun({ ...base, emailed: 3, recorded: 3 })).toBe(
      'Sent 3 reminders by email.',
    );
    expect(describeReminderRun({ ...base, emailed: 1, recorded: 1 })).toBe(
      'Sent 1 reminder by email.',
    );
  });

  it('says when nothing was due, and how many are waiting', () => {
    expect(describeReminderRun({ ...base, notDue: 4 })).toBe(
      'No reminders were sent. 4 people not reminded: they had a reminder in the last day, or have had every reminder.',
    );
  });

  it('gives the reasons for skips', () => {
    const text = describeReminderRun({
      ...base,
      emailed: 2,
      skipped: { notEmail: 1, noWording: 0, alreadySent: 2, noLongerEligible: 1 },
    });
    expect(text).toContain('Sent 2 reminders by email.');
    expect(text).toContain('1 chose text messages');
    expect(text).toContain('2 had already been sent');
    expect(text).toContain('1 submitted or stopped reminders meanwhile');
    expect(text).not.toContain('wording');
  });

  it('says so when the edition is not collecting', () => {
    expect(describeReminderRun({ ...base, collecting: false })).toMatch(/not collecting/);
  });
});
