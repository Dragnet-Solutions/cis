import { describe, expect, it } from 'vitest';
import {
  apportion,
  buildPlan,
  DEFAULT_PLAN_OPTIONS,
  DEFAULT_TARGETS,
  plannedRetailRatings,
  roundCount,
  type PlanOptions,
} from '../src/plan';

const firms = Array.from({ length: 80 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  displayName: `[Test] Firm ${String(i + 1).padStart(2, '0')}`,
}));
const opts = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  ...DEFAULT_PLAN_OPTIONS,
  seed: 'test-seed',
  targets: DEFAULT_TARGETS,
  ...over,
});

describe('buildPlan', () => {
  const plan = buildPlan(firms, opts());

  it('meets every target', () => {
    expect(plan.firms).toHaveLength(80);
    expect(plan.seats).toHaveLength(240);
    expect(plan.retail).toHaveLength(1111);
    expect(plan.local).toHaveLength(25);
    expect(plan.foreign).toHaveLength(15);
    expect(new Set(plan.seats.map((s) => s.key)).size).toBe(240);
  });

  it('is reproducible from the seed, and different for another seed', () => {
    expect(buildPlan(firms, opts())).toEqual(plan);
    const other = buildPlan(firms, opts({ seed: 'another' }));
    expect(other.retail.map((r) => r.ratedFirmIds)).not.toEqual(
      plan.retail.map((r) => r.ratedFirmIds),
    );
  });

  it('has every retail investor rate 2–3 distinct firms, recruited (if at all) by one of them', () => {
    for (const r of plan.retail) {
      expect(r.ratedFirmIds.length).toBeGreaterThanOrEqual(2);
      expect(r.ratedFirmIds.length).toBeLessThanOrEqual(3);
      expect(new Set(r.ratedFirmIds).size).toBe(r.ratedFirmIds.length);
      if (r.viaFirmId) expect(r.ratedFirmIds[0]).toBe(r.viaFirmId);
    }
    const via = plan.retail.filter((r) => r.viaFirmId).length / plan.retail.length;
    expect(via).toBeGreaterThan(0.7);
    expect(via).toBeLessThan(0.9);
  });

  it('gives a small-firm tail under ten retail investors and everyone else at least the head minimum', () => {
    const ratings = plannedRetailRatings(plan);
    const tail = plan.firms.filter((f) => f.isTail);
    expect(tail).toHaveLength(8);
    for (const f of tail) expect(ratings.get(f.id)).toBeLessThan(10);
    for (const f of plan.firms.filter((x) => !x.isTail)) {
      expect(ratings.get(f.id)!).toBeGreaterThanOrEqual(DEFAULT_PLAN_OPTIONS.headMin - 1);
    }
    // Skewed: the most popular firm has far more than the median one.
    const sorted = [...ratings.values()].sort((a, b) => b - a);
    expect(sorted[0]!).toBeGreaterThan(5 * sorted[40]!);
  });

  it('spreads firm quality so that some firms are strong and some weak', () => {
    const tiers = new Set(plan.firms.map((f) => f.tier));
    expect(tiers).toEqual(new Set(['strong', 'average', 'weak']));
  });

  it('makes a small share of investors lazy, and only obviously fake identities', () => {
    const all = [...plan.retail, ...plan.local, ...plan.foreign];
    const lazy = all.filter((r) => r.persona.kind !== 'normal').length / all.length;
    expect(lazy).toBeGreaterThan(0.02);
    expect(lazy).toBeLessThan(0.12);
    for (const r of all) {
      if (r.contact.email) expect(r.contact.email.endsWith('@test.example')).toBe(true);
      if (r.contact.phone) expect(r.contact.phone.startsWith('+234 000 555')).toBe(true);
    }
    const names = [...plan.local, ...plan.foreign].map((r) => r.institutionName!.toLowerCase());
    expect(new Set(names).size).toBe(names.length); // institutions count by distinct name
    for (const n of names) expect(n.startsWith('[test]')).toBe(true);
  });

  it('works at the small local-test scale', () => {
    const small = buildPlan(
      firms.slice(0, 8),
      opts({ targets: { firms: 8, retail: 120, local: 6, foreign: 4, regulators: 4 } }),
    );
    const ratings = plannedRetailRatings(small);
    expect([...ratings.values()].reduce((s, n) => s + n, 0)).toBe(
      small.retail.reduce((s, r) => s + r.ratedFirmIds.length, 0),
    );
    expect(small.firms.filter((f) => f.isTail)).toHaveLength(1);
  });
});

describe('apportion / roundCount', () => {
  it('apportions exactly the total', () => {
    expect(apportion([1, 1, 1], 10).reduce((s, x) => s + x, 0)).toBe(10);
    expect(apportion([3, 1], 4)).toEqual([3, 1]);
    expect(apportion([0, 0], 5)).toEqual([0, 0]);
  });
  it('rounds a cumulative fraction of a target', () => {
    expect(roundCount(1111, 0.3)).toBe(333);
    expect(roundCount(4, 0.3)).toBe(1);
    expect(roundCount(25, 1)).toBe(25);
    expect(roundCount(25, 0)).toBe(0);
  });
});
