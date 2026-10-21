/**
 * The Q0 scope-gate route: a conditional route over the ordinary sequence, not
 * a control. One function decides which steps a journey contains, for the
 * renderer, the server and the robot alike.
 */
import { describe, it, expect } from 'vitest';
import { applyScopeGate, buildJourneySequence, closesScope, type SurveyItem } from '../src';

const GATE: SurveyItem = {
  id: 'I-X-Q0',
  kind: 'single',
  text: 'How much direct operational dealing?',
  scope: 'shared',
  isDrgOps: false,
  scored: false,
  options: ['Regular and substantial', 'Occasional', 'Rare', 'Effectively none'],
  scopeGate: { closeOn: ['Rare', 'Effectively none'] },
};
const later = (n: number): SurveyItem => ({
  id: `I-X-Q${n}`,
  kind: 'single',
  text: `Q${n}`,
  scope: 'shared',
  isDrgOps: false,
  scored: false,
  options: ['A', 'B'],
});
const ITEMS = [GATE, later(1), later(2), later(3)];

function route(q0: unknown) {
  const steps = buildJourneySequence(ITEMS, []);
  return applyScopeGate(steps, (s) => (s.item.id === 'I-X-Q0' ? q0 : undefined));
}

describe('closesScope', () => {
  it('closes only on a declared closing option', () => {
    expect(closesScope(GATE, { a: 'Rare' })).toBe(true);
    expect(closesScope(GATE, { a: 'Effectively none' })).toBe(true);
    expect(closesScope(GATE, 'Rare')).toBe(true); // a bare stored value too
    expect(closesScope(GATE, { a: 'Occasional' })).toBe(false);
    expect(closesScope(GATE, { a: 'Regular and substantial' })).toBe(false);
    expect(closesScope(GATE, undefined)).toBe(false);
  });

  it('never closes on an item that declares no gate', () => {
    expect(closesScope(later(1), { a: 'Rare' })).toBe(false);
    expect(closesScope({ ...GATE, scopeGate: { closeOn: [] } }, { a: 'Rare' })).toBe(false);
  });
});

describe('applyScopeGate', () => {
  it('cuts the journey after a closing Q0: only Q0 remains', () => {
    for (const closing of ['Rare', 'Effectively none']) {
      const r = route({ a: closing });
      expect(r.closedAt).toBe(0);
      expect(r.steps.map((s) => s.item.id)).toEqual(['I-X-Q0']);
    }
  });

  it('keeps every step for a non-closing or missing Q0', () => {
    for (const q0 of [{ a: 'Occasional' }, { a: 'Regular and substantial' }, undefined]) {
      const r = route(q0);
      expect(r.closedAt).toBeNull();
      expect(r.steps.map((s) => s.item.id)).toEqual(['I-X-Q0', 'I-X-Q1', 'I-X-Q2', 'I-X-Q3']);
    }
  });

  it('is data-driven: an instrument with no gate is unaffected whatever is answered', () => {
    const steps = buildJourneySequence([later(1), later(2)], []);
    const r = applyScopeGate(steps, () => ({ a: 'Rare' }));
    expect(r.closedAt).toBeNull();
    expect(r.steps).toHaveLength(2);
  });

  it('a gate mid-instrument keeps the items before it and cuts the rest', () => {
    const mid = { ...GATE, id: 'I-X-Q2' };
    const steps = buildJourneySequence([later(1), mid, later(3)], []);
    const r = applyScopeGate(steps, (s) => (s.item.id === 'I-X-Q2' ? { a: 'Rare' } : undefined));
    expect(r.closedAt).toBe(1);
    expect(r.steps.map((s) => s.item.id)).toEqual(['I-X-Q1', 'I-X-Q2']);
  });
});
