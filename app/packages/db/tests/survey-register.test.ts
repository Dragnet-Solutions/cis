/**
 * SV-010 content-authority gate (real Postgres).
 *
 * Walks every question in the live seeded schema against the controlled
 * Register fixture and fails on any missing ID, text mismatch, option-set
 * mismatch, scope mismatch, kind mismatch, or flag mismatch. Per SV-010 §5,
 * "a comparison must fail on a missing ID rather than pass on a plausible
 * paraphrase." This is the permanent regression gate for any content update.
 * It covers every instrument in the Register (13: S1–S5b, I-SEC, I-NGX,
 * I-CSCS, I-DEP and the bespoke I-LCFE, I-NASD, I-FMDQ), on IDs, text,
 * options, sequence, limits, required/optional state and branches.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  seedSurveyRegister,
  getRegisterFixture,
  getInstrumentItems,
  INSTRUMENT_CODES,
  REGISTER_ITEM_COUNT,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from './setup';

let pool: Pool;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
});
afterAll(async () => {
  await closeTestPool();
});

const DRG_OPS_IDS = ['S1-A1', 'S2-A1', 'S3-A1', 'S3-A2', 'S4-A1', 'S5a-A1', 'S5b-A1'];

function norm<T>(v: T | undefined | null): T | null {
  return v === undefined ? null : v;
}

describe('SV-010 Register comparison gate', () => {
  it('every seeded item matches the Register by id, text, kind, scope, options and flags', async () => {
    await seedSurveyRegister(pool);
    const fixture = getRegisterFixture();

    let totalSeen = 0;
    let drgSeen = 0;

    for (const code of INSTRUMENT_CODES) {
      const rawItems = fixture.instruments[code] ?? [];
      const liveItems = await getInstrumentItems(pool, code);
      const liveById = new Map(liveItems.map((i) => [i.id, i]));

      // No extra live rows beyond the Register, and the Register's sequence.
      expect(liveItems.length).toBe(rawItems.length);
      expect(
        liveItems.map((i) => i.id),
        `sequence for ${code}`,
      ).toEqual(rawItems.map((r) => r.question_id));

      for (const raw of rawItems) {
        totalSeen += 1;
        if (raw.is_drg_ops) drgSeen += 1;

        const live = liveById.get(raw.question_id);
        // Fail on a MISSING ID, not on a paraphrase.
        expect(live, `missing question id ${raw.question_id}`).toBeDefined();
        if (!live) continue;

        expect(live.text, `text mismatch for ${raw.question_id}`).toBe(raw.text);
        expect(live.kind, `kind mismatch for ${raw.question_id}`).toBe(raw.kind);
        expect(live.scope, `scope mismatch for ${raw.question_id}`).toBe(raw.scope);
        expect(norm(live.options), `options mismatch for ${raw.question_id}`).toEqual(
          norm(raw.options),
        );
        expect(live.isDrgOps, `drg flag mismatch for ${raw.question_id}`).toBe(!!raw.is_drg_ops);
        expect(live.scored, `scored flag mismatch for ${raw.question_id}`).toBe(raw.scored ?? true);
        // Limits, required/optional state and per-kind rules.
        const flag = (v: number | undefined) => v === 1;
        expect(norm(live.selectUpToN), `select limit for ${raw.question_id}`).toBe(
          norm(raw.select_up_to_n),
        );
        expect(norm(live.rankExactlyN), `rank limit for ${raw.question_id}`).toBe(
          norm(raw.rank_exactly_n),
        );
        expect(!!live.selectThenGreatest, `greatest rule for ${raw.question_id}`).toBe(
          flag(raw.select_then_greatest),
        );
        expect(!!live.answerOptional, `required/optional for ${raw.question_id}`).toBe(
          flag(raw.answer_optional),
        );
        expect(!!live.hasOptionalComment, `comment for ${raw.question_id}`).toBe(
          flag(raw.has_optional_comment),
        );
        expect(norm(live.conditionalDetailOn), `detail rule for ${raw.question_id}`).toBe(
          norm(raw.conditional_detail_on),
        );
        expect(norm(live.scaleMin), `scale min for ${raw.question_id}`).toBe(norm(raw.scale_min));
        expect(norm(live.scaleMax), `scale max for ${raw.question_id}`).toBe(norm(raw.scale_max));
        expect(norm(live.scaleAnchors), `anchors for ${raw.question_id}`).toBe(
          norm(raw.scale_anchors),
        );
        expect(norm(live.gridRows), `grid rows for ${raw.question_id}`).toEqual(
          norm(raw.grid_rows),
        );
        expect(norm(live.gridDimensions), `grid dims for ${raw.question_id}`).toEqual(
          norm(raw.grid_dimensions),
        );
        expect(norm(live.gridScale), `grid scale for ${raw.question_id}`).toEqual(
          norm(raw.grid_scale),
        );
        // Branches: SV-010 §4a — the Register has none, except a scope gate a
        // later controlled decision authorises (Q0, CIS sign-off 21 Oct 2026).
        // The runtime branch must be exactly the Register's, decision included.
        expect(norm(live.scopeGate), `branch for ${raw.question_id}`).toEqual(
          raw.scope_gate
            ? { closeOn: raw.scope_gate.close_on, decision: raw.scope_gate.decision }
            : null,
        );
      }
    }

    expect(totalSeen).toBe(REGISTER_ITEM_COUNT);
    expect(drgSeen).toBe(DRG_OPS_IDS.length);
  });

  it('has exactly the seven expected DRG-OPS items and the verified firm-specific counts', async () => {
    await seedSurveyRegister(pool);
    const fixture = getRegisterFixture();

    const drgIds: string[] = [];
    const firmCounts: Record<string, number> = {};
    for (const code of INSTRUMENT_CODES) {
      const items = fixture.instruments[code] ?? [];
      firmCounts[code] = items.filter((i) => i.scope === 'firm_specific').length;
      for (const i of items) if (i.is_drg_ops) drgIds.push(i.question_id);
    }

    expect(drgIds.sort()).toEqual([...DRG_OPS_IDS].sort());
    // Verified firm-specific counts (Phase 2 §3).
    expect(firmCounts['S4']).toBe(11);
    expect(firmCounts['S5a']).toBe(6);
    expect(firmCounts['S5b']).toBe(3);
    // Family D (I-DEP, Phase 19) is institutional/contextual, same category
    // as the existing Family A/B/C instruments — neither DRG-OPS nor
    // firm-specific. Its addition intentionally moves REGISTER_ITEM_COUNT
    // 90 → 95; this loop confirms it didn't also move a count it shouldn't.
    for (const code of [
      'S1',
      'S2',
      'S3',
      'I-SEC',
      'I-NGX',
      'I-CSCS',
      'I-DEP',
      'I-LCFE',
      'I-NASD',
      'I-FMDQ',
    ]) {
      expect(firmCounts[code]).toBe(0);
    }
  });

  it('covers every instrument in the Register, the three bespoke institutional ones included', async () => {
    const fixture = getRegisterFixture();
    expect([...INSTRUMENT_CODES].sort()).toEqual(Object.keys(fixture.instruments).sort());
    expect(INSTRUMENT_CODES).toEqual(
      expect.arrayContaining(['I-SEC', 'I-NGX', 'I-CSCS', 'I-LCFE', 'I-NASD', 'I-FMDQ']),
    );
    expect(INSTRUMENT_CODES).toHaveLength(13);
    for (const code of ['I-LCFE', 'I-NASD', 'I-FMDQ']) {
      const items = fixture.instruments[code]!;
      // The document's ID scheme: Q0 scope gate, then Q1–Q5.
      expect(items.map((i) => i.question_id)).toEqual(
        [0, 1, 2, 3, 4, 5].map((n) => `${code}-Q${n}`),
      );
      expect(items.every((i) => i.scored === false)).toBe(true);
    }
  });

  it('a branch is admitted only on the items that carry a controlled decision', () => {
    const fixture = getRegisterFixture();
    const gated = Object.values(fixture.instruments)
      .flat()
      .filter((i) => i.scope_gate);
    expect(gated.map((i) => i.question_id).sort()).toEqual(['I-FMDQ-Q0', 'I-LCFE-Q0', 'I-NASD-Q0']);
    for (const g of gated) {
      expect(g.scope_gate!.close_on).toEqual(['Rare', 'Effectively none']);
      expect(g.scope_gate!.decision).toMatch(/supersedes SV-010/);
    }
  });

  it('fails on a missing ID rather than passing a paraphrase', async () => {
    await seedSurveyRegister(pool);
    await pool.query(
      `UPDATE instrument_questions SET question_code = 'I-LCFE-Q9' WHERE question_code = 'I-LCFE-Q3'`,
    );
    const live = await getInstrumentItems(pool, 'I-LCFE');
    const raw = getRegisterFixture().instruments['I-LCFE']!;
    const liveIds = new Set(live.map((i) => i.id));
    expect(raw.filter((r) => !liveIds.has(r.question_id)).map((r) => r.question_id)).toEqual([
      'I-LCFE-Q3',
    ]);
  });
});
