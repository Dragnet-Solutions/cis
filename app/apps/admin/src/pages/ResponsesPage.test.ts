/**
 * ResponsesPage live-wiring fix (UX-OPS-003) — confirms the page can no
 * longer render the old "self-contained local state" mockup: no hardcoded
 * CARDS/DEPS fixture arrays standing in for the real, tested, already-routed
 * `responses-monitoring-service.ts` (via `apps/api/src/routes/monitoring.ts`)
 * built in the same Phase 13 commit that shipped this page.
 *
 * A raw source scan rather than a render test — there is no DOM test
 * infrastructure in this repo (the "unit" Vitest project runs with
 * environment: 'node').
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const SOURCE = readFileSync(new URL('./ResponsesPage.tsx', import.meta.url), 'utf8');

describe('ResponsesPage — no local-state mockup remains reachable', () => {
  it('has no hardcoded segment-card or dependency-row fixture arrays', () => {
    for (const banned of [
      'const CARDS: Card[]',
      'const DEPS: DepRow[]',
      'current: 61',
      'current: 436',
      "label: 'Participating firms'",
    ]) {
      expect(SOURCE, `source still contains "${banned}"`).not.toContain(banned);
    }
  });

  it('takes real client/editionId props, not zero props', () => {
    expect(SOURCE).toMatch(/export function ResponsesPage\(\{\s*client,\s*editionId,?\s*\}/);
  });

  it('calls the real backend for the monitor', () => {
    expect(SOURCE).toContain('client.getResponsesMonitor');
  });

  it('renders from the live monitor object, not a static constant', () => {
    expect(SOURCE).toMatch(/monitor\.cards\.map/);
    expect(SOURCE).toMatch(/monitor\.dependencies\.map/);
  });
});
