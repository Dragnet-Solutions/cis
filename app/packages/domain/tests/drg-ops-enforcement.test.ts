/**
 * DRG-OPS non-disclosure enforcement (real Postgres). The platform's
 * non-negotiable rule: an operational (DRG-OPS) question can never surface in
 * any public / firm-facing / report / evidence-pack query. Extended in Phase 2
 * to cover all seven DRG-OPS items by ID, and to confirm they DO remain part of
 * the respondent runtime (folded invisibly into the instrument flow).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getPublicVisibleQuestions, getInstrumentItems, createInstrumentQuestion } from '@cis/db';
import { seedReferenceData } from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;

const DRG_OPS_IDS = ['S1-A1', 'S2-A1', 'S3-A1', 'S3-A2', 'S4-A1', 'S5a-A1', 'S5b-A1'];

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

describe('DRG-OPS exclusion from public questions', () => {
  it('never returns any of the seven DRG-OPS items from the public-question query', async () => {
    await seedReferenceData(pool);

    const publicQuestions = await getPublicVisibleQuestions(pool);
    expect(publicQuestions.length).toBeGreaterThan(0);
    expect(publicQuestions.every((q) => q.isDrgOps === false)).toBe(true);

    const publicCodes = new Set(publicQuestions.map((q) => q.questionCode));
    for (const id of DRG_OPS_IDS) {
      expect(publicCodes.has(id), `${id} must be excluded from public questions`).toBe(false);
    }
    // Public count = 95 total (Phase 19 added Family D's 5-item I-DEP) − 7 DRG-OPS.
    expect(publicQuestions.length).toBe(88);
  });

  it('DRG-OPS items ARE part of the respondent runtime (folded into the flow)', async () => {
    await seedReferenceData(pool);
    const s1Items = await getInstrumentItems(pool, 'S1');
    expect(s1Items.some((i) => i.id === 'S1-A1')).toBe(true);
    const s1a1 = s1Items.find((i) => i.id === 'S1-A1');
    expect(s1a1?.isDrgOps).toBe(true);
    expect(s1a1?.scored).toBe(false);
  });

  it('excludes a freshly-created DRG-OPS question too', async () => {
    const seed = await seedReferenceData(pool);
    const s1 = seed.instruments['S1'];
    expect(s1).toBeDefined();

    const drg = await createInstrumentQuestion(pool, {
      instrumentDefinitionId: s1 as string,
      questionCode: 'S1-A99',
      promptText: 'A brand-new operational probe.',
      kind: 'select',
      isDrgOps: true,
    });
    expect(drg.isDrgOps).toBe(true);
    expect(drg.scored).toBe(false); // forced false for DRG-OPS

    const publicQuestions = await getPublicVisibleQuestions(pool);
    expect(publicQuestions.some((q) => q.questionCode === 'S1-A99')).toBe(false);
  });

  it('the DB forbids a scored DRG-OPS question', async () => {
    const seed = await seedReferenceData(pool);
    const s1 = seed.instruments['S1'];
    await expect(
      pool.query(
        `INSERT INTO instrument_questions
           (instrument_definition_id, question_code, prompt_text, kind, scored, is_drg_ops)
         VALUES ($1, 'S1-BAD', 'illegal', 'select', TRUE, TRUE)`,
        [s1],
      ),
    ).rejects.toThrow(/drg_ops_never_scored/);
  });
});
