/**
 * Post-demo findings (§1a/§1b, and the follow-up correction) — regression
 * tests for the parts of the Mission Board page that remain static exports:
 * the severity-rank label map and the navigation rail. Card content itself
 * is no longer static (the page fetches the real, live-evaluated board —
 * see MissionBoardPage.tsx's header comment and App.tsx's wiring), so its
 * copy is guarded where it's actually produced:
 * packages/domain/tests/mission-board.test.ts, "No brief-derived
 * illustration or system-mechanism leakage in card/action copy".
 *
 *  §1a: internal engineering rationale ("folded in — not a separate card",
 *       "(correct, not a bug)", "honest stub") must never leak into rail
 *       copy or the severity labels this page still owns.
 *  §1b: three rail labels claimed "not built" for surfaces that ship real,
 *       routed pages (Regulators — Phase 12, Monitoring — Phase 13, Dragnet
 *       analysis — Phase 16). This test asserts every RAIL entry marked
 *       `built: true` (all six, now) carries no stale "not built" qualifier.
 *  Correction: the severity labels were previously the brief's own §5
 *  severity-table wording verbatim (e.g. rank 2's 'Statistical target
 *  threatened'). They are now freshly written for this screen — this test
 *  guards against that exact phrase, and the same class of phrase,
 *  reappearing.
 */
import { describe, it, expect } from 'vitest';
import { SEVERITY_LABEL, RAIL, railFor } from './MissionBoardPage';

// Implementation-mechanics/internal-rationale phrasing, and the specific
// brief-table wording previously found, matched broadly rather than as an
// exact phrase list, so a differently-worded re-leak of the same class is
// still caught.
const MECHANICS_JARGON = [
  /folded in/i,
  /not a separate card/i,
  /correct,\s*not a bug/i,
  /honest stub/i,
  /\bdedup(e|lication)?\b/i,
  /\bengine\s*[12]\b/i,
  /^statistical target threatened$/i,
];

function assertNoMechanicsJargon(label: string, text: string): void {
  for (const pattern of MECHANICS_JARGON) {
    expect(text, `${label} contains internal-mechanics jargon: "${text}"`).not.toMatch(pattern);
  }
}

describe('Mission Board — no leaked internal-mechanics jargon in user-facing copy (§1a)', () => {
  it("no severity-rank label leaks implementation mechanics or the brief's own table wording", () => {
    for (const [rank, label] of Object.entries(SEVERITY_LABEL)) {
      assertNoMechanicsJargon(`severity rank ${rank}`, label);
    }
  });

  it('no rail label leaks implementation mechanics', () => {
    for (const section of RAIL) {
      assertNoMechanicsJargon(`rail section "${section.key}"`, section.label);
    }
  });
});

describe('Mission Board rail — no stale "not built" claim for a routed surface (§1b)', () => {
  it('every rail entry marked built carries no "not built" qualifier in its label', () => {
    for (const section of RAIL) {
      if (section.built) {
        expect(
          section.label,
          `rail section "${section.key}" is built but its label still claims otherwise`,
        ).not.toMatch(/not built/i);
      }
    }
  });

  it('Regulators, Monitoring and Dragnet analysis are marked built — the three confirmed-shipped surfaces', () => {
    const byKey = new Map(RAIL.map((s) => [s.key, s]));
    expect(byKey.get('regulators')?.built).toBe(true);
    expect(byKey.get('regulators')?.label).toBe('Regulators');
    expect(byKey.get('monitoring')?.built).toBe(true);
    expect(byKey.get('monitoring')?.label).toBe('Monitoring');
    expect(byKey.get('dragnet')?.built).toBe(true);
    expect(byKey.get('dragnet')?.label).toBe('Dragnet analysis');
  });
});

describe('Mission Board rail — every shortcut navigates (QA F7/F8)', () => {
  it('every rail entry names the shell tab it opens', () => {
    const tabs = ['invitations', 'regulators', 'responses', 'scoring', 'dragnet', 'edition'];
    for (const section of RAIL) {
      expect(tabs, `rail section "${section.key}" has no navigation target`).toContain(
        section.target,
      );
    }
  });
});

// Regression (E2E 2026-10-09, D11): a CIS user without the Dragnet right saw a
// greyed "Dragnet analysis" item on the rail, although the nav hides that tab.
describe('Mission Board rail — Dragnet analysis only for the Dragnet right', () => {
  it('is hidden from someone without the right and shown to someone with it', () => {
    expect(railFor(false).map((s) => s.key)).not.toContain('dragnet');
    expect(railFor(true).map((s) => s.key)).toContain('dragnet');
    // Nothing else is hidden by the right.
    expect(railFor(false)).toHaveLength(RAIL.length - 1);
  });
});
