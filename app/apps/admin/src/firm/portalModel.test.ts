/**
 * Regression tests for the model behind the firm portal. Two of the three
 * originally-confirmed v14.5 defects still apply directly:
 *  §2b pips 3/4 were unreachable → the indicator is two pips and no view
 *      lights more than that.
 *  §2c access_model was a phantom state → it is absent from PORTAL_VIEWS.
 * The third (§2a, surveyNotBuilt dead code) no longer applies in the shape it
 * was fixed in — Task D's rebuild gives a seat row a REAL entry point (Part
 * 6) instead of a "not built" feedback path, so `notBuiltForSeat` and its
 * test are retired rather than kept alive as dead code.
 */
import { describe, it, expect } from 'vitest';
import {
  PORTAL_VIEWS,
  PROGRESS_PIP_COUNT,
  pipsOnFor,
  replacementCost,
  type PortalView,
} from './portalModel';

describe('§2c — no access_model view', () => {
  it('access_model is not a real view', () => {
    expect((PORTAL_VIEWS as readonly string[]).includes('access_model')).toBe(false);
  });
  it('lists exactly the real claim/sign-in views, no invented invitation-code state', () => {
    expect(PORTAL_VIEWS).toHaveLength(6);
    // No manually-typed invitation code exists server-side (claimSpace takes
    // no code); a second claimant is redirected to sign in instead.
    expect((PORTAL_VIEWS as readonly string[]).includes('code')).toBe(false);
    expect((PORTAL_VIEWS as readonly string[]).includes('halfway')).toBe(false);
  });
});

describe('§2b — progress indicator has no unreachable pips', () => {
  it('has exactly two pips', () => {
    expect(PROGRESS_PIP_COUNT).toBe(2);
  });
  it('no view lights more pips than exist', () => {
    for (const v of PORTAL_VIEWS) {
      const on = pipsOnFor(v as PortalView);
      expect(on).toBeGreaterThanOrEqual(0);
      expect(on).toBeLessThanOrEqual(PROGRESS_PIP_COUNT);
    }
  });
  it('every pip position is reachable by some view', () => {
    const maxSeen = Math.max(...PORTAL_VIEWS.map((v) => pipsOnFor(v as PortalView)));
    expect(maxSeen).toBe(PROGRESS_PIP_COUNT);
    expect(PORTAL_VIEWS.some((v) => pipsOnFor(v as PortalView) === 1)).toBe(true);
    expect(PORTAL_VIEWS.some((v) => pipsOnFor(v as PortalView) === 2)).toBe(true);
  });
});

describe('seat replacement cost mirrors the domain rule', () => {
  it('started → data-loss warning', () => {
    const c = replacementCost('started', 'Bola');
    expect(c.requiresConfirm).toBe(true);
    expect(c.warning).toMatch(/lost/i);
  });
  it('complete → discard warning', () => {
    const c = replacementCost('complete', 'Ngozi');
    expect(c.requiresConfirm).toBe(true);
    expect(c.warning).toMatch(/discard/i);
  });
  it('invited/empty → no cost', () => {
    expect(replacementCost('invited', 'Sam').requiresConfirm).toBe(false);
    expect(replacementCost('empty', null).warning).toBeNull();
  });
});
