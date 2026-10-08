/**
 * Pure renderer-logic tests — the behaviours UX-X-RENDER-001 exists to keep
 * correct, ported from the approved control and testable without a browser.
 */
import { describe, it, expect } from 'vitest';
import {
  getCanonical,
  setAnswer,
  setComment,
  scaleColumns,
  isAnswered,
  outstanding,
  toggleSelect,
  toggleRank,
  sharedItems,
  perFirmItems,
  type SurveyItem,
} from '../src';

function item(partial: Partial<SurveyItem> & Pick<SurveyItem, 'id' | 'kind'>): SurveyItem {
  return {
    text: partial.id,
    scope: 'shared',
    isDrgOps: false,
    scored: true,
    ...partial,
  };
}

describe('canonical answer shape {a, c}', () => {
  it('preserves the answer when a comment is typed after answering', () => {
    let v: unknown = undefined;
    v = setAnswer(v, 7);
    v = setComment(v, 'a note');
    expect(getCanonical(v).a).toBe(7);
    expect(getCanonical(v).c).toBe('a note');
  });

  it('preserves the answer when a comment is typed BEFORE answering (the historical defect)', () => {
    let v: unknown = undefined;
    v = setComment(v, 'a note'); // comment first — must not create a "commented-but-answered" state
    expect(isAnswered(item({ id: 'S1-Q2', kind: 'scale', scaleMin: 1, scaleMax: 10 }), v)).toBe(
      false,
    );
    v = setAnswer(v, 4); // now answer
    expect(getCanonical(v).a).toBe(4);
    expect(getCanonical(v).c).toBe('a note'); // comment survived
  });

  it('a comment alone never counts as an answer', () => {
    const v = setComment(undefined, 'just a comment');
    expect(isAnswered(item({ id: 'S1-Q7', kind: 'open' }), v)).toBe(false);
  });
});

describe('scale layout by target count', () => {
  it('lays a 10-point scale out 5×2', () => {
    expect(scaleColumns(10)).toBe(5);
  });
  it('lays an 11-point scale out 6-then-5', () => {
    expect(scaleColumns(11)).toBe(6);
  });
  it('a 0-based NPS scale (0..10) is 11 targets → 6 columns', () => {
    const npsCount = 10 - 0 + 1;
    expect(npsCount).toBe(11);
    expect(scaleColumns(npsCount)).toBe(6);
  });
});

describe('scale answers include zero', () => {
  it('treats 0 as a real answer (NPS detractor), not empty', () => {
    const nps = item({ id: 'S4-Q11', kind: 'scale', scaleMin: 0, scaleMax: 10 });
    expect(isAnswered(nps, setAnswer(undefined, 0))).toBe(true);
    expect(isAnswered(nps, undefined)).toBe(false);
  });
});

describe('select-up-to-N cap', () => {
  const cap = 3;
  it('refuses a 4th selection rather than truncating', () => {
    let picked: string[] = [];
    picked = toggleSelect(picked, 'A', cap);
    picked = toggleSelect(picked, 'B', cap);
    picked = toggleSelect(picked, 'C', cap);
    picked = toggleSelect(picked, 'D', cap); // over cap — refused
    expect(picked).toEqual(['A', 'B', 'C']);
  });
  it('has a floor of one (empty is outstanding)', () => {
    const sel = item({ id: 'S2-Q2', kind: 'select', selectUpToN: cap });
    expect(isAnswered(sel, setAnswer(undefined, []))).toBe(false);
    expect(isAnswered(sel, setAnswer(undefined, ['A']))).toBe(true);
  });
});

describe('select-then-greatest', () => {
  const sel = item({ id: 'I-SEC-Q1', kind: 'select', selectUpToN: 3, selectThenGreatest: true });
  it('is not answered until the greatest is picked from the chosen set', () => {
    const chosen = setAnswer(undefined, { picked: ['A', 'B'] });
    expect(isAnswered(sel, chosen)).toBe(false);
    expect(outstanding(sel, chosen)).toMatch(/greatest consequence/);
    const withGreatest = setAnswer(undefined, { picked: ['A', 'B'], greatest: 'A' });
    expect(isAnswered(sel, withGreatest)).toBe(true);
  });
});

describe('rank-exactly-N', () => {
  const rk = item({ id: 'S1-Q1', kind: 'rank', rankExactlyN: 3 });
  it('rejects a partial ranking and names how many remain', () => {
    let order: string[] = [];
    order = toggleRank(order, 'A', 3);
    order = toggleRank(order, 'B', 3);
    const partial = setAnswer(undefined, order);
    expect(isAnswered(rk, partial)).toBe(false);
    expect(outstanding(rk, partial)).toBe('Choose 3, in order. 2 of 3 chosen.');
    order = toggleRank(order, 'C', 3);
    expect(isAnswered(rk, setAnswer(undefined, order))).toBe(true);
  });
  it('does not add beyond N', () => {
    let order = ['A', 'B', 'C'];
    order = toggleRank(order, 'D', 3);
    expect(order).toEqual(['A', 'B', 'C']);
  });
});

describe('grid validation is by data, identical regardless of layout', () => {
  // Two-dimension performance/risk grid (S3-Q4 shape).
  const grid = item({
    id: 'S3-Q4',
    kind: 'grid',
    gridRows: ['Onboarding', 'Transfers'],
    gridDimensions: { Performance: ['Good'], Risk: ['Low'] },
  });
  it('is outstanding until every row has every dimension', () => {
    const partial = setAnswer(undefined, { Onboarding: { Performance: 'Good', Risk: 'Low' } });
    expect(isAnswered(grid, partial)).toBe(false);
    const complete = setAnswer(undefined, {
      Onboarding: { Performance: 'Good', Risk: 'Low' },
      Transfers: { Performance: 'Good', Risk: 'Low' },
    });
    expect(isAnswered(grid, complete)).toBe(true);
  });
});

describe('yes/no with conditional detail', () => {
  const yn = item({ id: 'S5a-Q4', kind: 'yesno', conditionalDetailOn: 'Yes' });
  it('requires detail only when the answer is the conditional value', () => {
    expect(isAnswered(yn, setAnswer(undefined, { v: 'No' }))).toBe(true);
    expect(isAnswered(yn, setAnswer(undefined, { v: 'Yes' }))).toBe(false);
    expect(isAnswered(yn, setAnswer(undefined, { v: 'Yes', detail: 'what happened' }))).toBe(true);
  });
});

describe('scope split', () => {
  const items = [
    item({ id: 'S4-P1', kind: 'single', scope: 'shared' }),
    item({ id: 'S4-Q1', kind: 'scale', scope: 'firm_specific' }),
    item({ id: 'S4-Q2', kind: 'scale', scope: 'firm_specific' }),
  ];
  it('splits shared once vs firm-specific by scope', () => {
    expect(sharedItems(items).map((i) => i.id)).toEqual(['S4-P1']);
    expect(perFirmItems(items).map((i) => i.id)).toEqual(['S4-Q1', 'S4-Q2']);
  });
});

describe('answer_optional (S4-Q10)', () => {
  it('an optional open item is complete when blank', () => {
    const opt = item({ id: 'S4-Q10', kind: 'open', scope: 'firm_specific', answerOptional: true });
    expect(isAnswered(opt, undefined)).toBe(true);
  });
});
