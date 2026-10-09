/**
 * Regressions (E2E 2026-10-09):
 *  D12 — on launch day the banner said the planned launch date "has passed".
 *  D18 — after an early lock the last day for returns read "Passed" next to a
 *        date eleven days in the future.
 */
import { describe, it, expect } from 'vitest';
import { dateStanding, launchDateBanner, lockedClosingLabel } from './EditionPage';

// 9 October 2026, mid-morning in the viewer's timezone.
const TODAY = new Date(2026, 9, 9, 10, 30);

describe('dateStanding', () => {
  it('reads the date the operator set, against the viewer’s own today', () => {
    expect(dateStanding('2026-10-08T00:00:00.000Z', TODAY)).toBe('past');
    expect(dateStanding('2026-10-09T00:00:00.000Z', TODAY)).toBe('today');
    expect(dateStanding('2026-10-20T00:00:00.000Z', TODAY)).toBe('future');
  });
});

describe('Launch-date banner (D12)', () => {
  it('says "has arrived" on the day and "has passed" only afterwards', () => {
    expect(launchDateBanner('2026-10-09T00:00:00.000Z', TODAY)).toMatch(/has arrived/);
    expect(launchDateBanner('2026-10-08T00:00:00.000Z', TODAY)).toMatch(/has passed/);
  });
});

describe('Last day for returns once locked (D18)', () => {
  it('reads "Closed early" when the results were locked before the last day', () => {
    const label = lockedClosingLabel('2026-10-20T00:00:00.000Z', TODAY);
    expect(label.pill).toBe('Closed early (results locked)');
    expect(label.pill).not.toMatch(/Passed/);
  });

  it('reads "Passed" only when the last day is actually behind us', () => {
    expect(lockedClosingLabel('2026-10-01T00:00:00.000Z', TODAY).pill).toBe('Passed');
    expect(lockedClosingLabel('2026-10-09T00:00:00.000Z', TODAY).pill).not.toBe('Passed');
  });
});
