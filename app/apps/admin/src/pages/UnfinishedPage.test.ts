/**
 * UnfinishedPage live-wiring fix (UX-OPS-004) — confirms the page can no
 * longer render the old "self-contained local state" mockup: no hardcoded
 * DATA/STOPS/INITIAL_SCHEDULE fixtures, and — the part that made this one
 * worse than a read-only mockup — no local-only schedule editor that LOOKED
 * like it persisted a real setting while doing nothing. The real, tested,
 * already-routed `reminder-timing-service.ts` (via
 * `apps/api/src/routes/monitoring.ts`) was built in the same Phase 13 commit
 * that shipped this page.
 *
 * A raw source scan rather than a render test — there is no DOM test
 * infrastructure in this repo (the "unit" Vitest project runs with
 * environment: 'node').
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const SOURCE = readFileSync(new URL('./UnfinishedPage.tsx', import.meta.url), 'utf8');

describe('UnfinishedPage — no local-state mockup remains reachable', () => {
  it('has no hardcoded stats/dropoff/schedule fixtures', () => {
    for (const banned of [
      'const DATA = { started: 1874',
      'const STOPS = [',
      'const INITIAL_SCHEDULE',
      "'Q1 — which firms do you use'",
      "'Q6 — per-firm rating grid'",
    ]) {
      expect(SOURCE, `source still contains "${banned}"`).not.toContain(banned);
    }
  });

  it('takes real client/editionId props, not zero props', () => {
    expect(SOURCE).toMatch(/export function UnfinishedPage\(\{\s*client,\s*editionId,?\s*\}/);
  });

  it('calls the real backend to load, and to persist schedule/cap changes', () => {
    for (const call of [
      'client.getUnfinished',
      'client.setReminderSchedule',
      'client.setReminderCap',
    ]) {
      expect(SOURCE, `source never calls "${call}"`).toContain(call);
    }
  });

  it('the schedule editor mutates only a draft until an explicit save, which calls the real route', () => {
    expect(SOURCE).toMatch(/setDraftSchedule/);
    expect(SOURCE).toMatch(/async function saveSchedule/);
  });
});
