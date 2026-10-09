/**
 * SV-010 content-authority gate (real Postgres).
 *
 * Walks every question in the live seeded schema against the controlled
 * Register fixture and fails on any missing ID, text mismatch, option-set
 * mismatch, scope mismatch, kind mismatch, or flag mismatch. Per SV-010 §5,
 * "a comparison must fail on a missing ID rather than pass on a plausible
 * paraphrase." This is the permanent regression gate for any content update.
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

      // No extra live rows beyond the Register.
      expect(liveItems.length).toBe(rawItems.length);

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
    for (const code of ['S1', 'S2', 'S3', 'I-SEC', 'I-NGX', 'I-CSCS', 'I-DEP']) {
      expect(firmCounts[code]).toBe(0);
    }
  });
});
