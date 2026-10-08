/**
 * Journey-sequencing tests. The controlled rule (QUESTION_SCOPE_MAPPING): scope
 * grouping supersedes the Register's literal order — all shared items first,
 * then firm-specific items repeated per rated firm, each group in Register
 * order. One function drives every multi-firm instrument.
 */
import { describe, it, expect } from 'vitest';
import { buildJourneySequence, firmContextAt, type SurveyItem } from '../src';

function item(id: string, scope: 'shared' | 'firm_specific'): SurveyItem {
  return { id, kind: 'single', text: id, scope, isDrgOps: false, scored: true };
}

// A slice of S4 in *Register order* — note S4-Q12 and S4-A1 (shared) sit
// BETWEEN firm-specific questions, exactly the interleave the rule addresses.
const S4_REGISTER_ORDER: SurveyItem[] = [
  item('S4-P1', 'shared'),
  item('S4-Q1', 'firm_specific'),
  item('S4-Q2', 'firm_specific'),
  item('S4-Q9', 'firm_specific'),
  item('S4-Q12', 'shared'), // interleaved shared
  item('S4-A1', 'shared'), // interleaved shared (DRG-OPS)
  item('S4-Q10', 'firm_specific'),
  item('S4-Q11', 'firm_specific'),
];

describe('buildJourneySequence', () => {
  it('renders all shared items before the firm loop, then firm-specific per firm in Register order', () => {
    const steps = buildJourneySequence(S4_REGISTER_ORDER, ['firm-B', 'firm-C']);

    // Shared first, in Register order, none carrying a rated firm.
    const shared = steps.filter((s) => s.ratedFirmId === null);
    expect(shared.map((s) => s.item.id)).toEqual(['S4-P1', 'S4-Q12', 'S4-A1']);

    // Then firm B's firm-specific items in Register order, then firm C's.
    const firmB = steps.filter((s) => s.ratedFirmId === 'firm-B');
    const firmC = steps.filter((s) => s.ratedFirmId === 'firm-C');
    const expectedPerFirm = ['S4-Q1', 'S4-Q2', 'S4-Q9', 'S4-Q10', 'S4-Q11'];
    expect(firmB.map((s) => s.item.id)).toEqual(expectedPerFirm);
    expect(firmC.map((s) => s.item.id)).toEqual(expectedPerFirm);

    // The interleaved shared items are NOT asked mid-firm-loop.
    const firstFirmStep = steps.findIndex((s) => s.ratedFirmId !== null);
    expect(steps.slice(0, firstFirmStep).every((s) => s.ratedFirmId === null)).toBe(true);

    // Total = shared + perFirm * firmCount.
    expect(steps).toHaveLength(3 + 5 * 2);
  });

  it('a single-scope instrument has no firm loop', () => {
    const s1 = [item('S1-Q1', 'shared'), item('S1-Q2', 'shared'), item('S1-A1', 'shared')];
    const steps = buildJourneySequence(s1, []);
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => s.ratedFirmId === null)).toBe(true);
  });

  it('firmContextAt restores the exact rated firm and loop position mid-loop', () => {
    const steps = buildJourneySequence(S4_REGISTER_ORDER, ['firm-B', 'firm-C']);
    // First firm-C step: after 3 shared + 5 firm-B = index 8.
    const ctx = firmContextAt(steps, 8);
    expect(ctx.ratedFirmId).toBe('firm-C');
    expect(ctx.firmIndex).toBe(2);
    expect(ctx.firmCount).toBe(2);
  });
});
