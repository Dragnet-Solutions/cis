/**
 * Response storage integration tests (real Postgres). Covers Phase 2 DoD:
 *  - Rated Firm ID vs Source/Recruiting Firm ID separation (SV-010 §3)
 *  - scope-driven split: shared once (no rated firm), firm-specific per firm
 *  - no shared answer copied across firms
 *  - consent gate for S5a/S5b
 *  - immutability: no overwrite (unique) and DB trigger blocks UPDATE
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  createRespondent,
  getResponsesForRespondent,
  getRatedFirmsForRespondent,
} from '@cis/db';
import { seedReferenceData, submitResponses, ConsentRequiredError } from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
});
afterAll(async () => {
  await closeTestPool();
});

async function firm(slug: string) {
  return createOrganization(pool, { slug, displayName: slug.toUpperCase(), orgType: 'firm' });
}

describe('Rated Firm vs Recruiting Firm separation', () => {
  it('a respondent recruited via Firm A rates only the firms independently chosen (B, C) — never A', async () => {
    const a = await firm('firm-a');
    const b = await firm('firm-b');
    const c = await firm('firm-c');

    const respondent = await createRespondent(pool, {
      editionId,
      instrumentCode: 'S4',
      recruitingFirmId: a.id,
    });

    await submitResponses(pool, {
      editionId,
      respondentId: respondent.id,
      sharedAnswers: { 'S4-P1': { a: '₦50,000 to ₦500,000' } },
      firmAnswers: {
        [b.id]: { 'S4-Q1': { a: 8 } },
        [c.id]: { 'S4-Q1': { a: 5 } },
      },
    });

    const ratedFirms = await getRatedFirmsForRespondent(pool, respondent.id);
    expect(ratedFirms.sort()).toEqual([b.id, c.id].sort());
    expect(ratedFirms).not.toContain(a.id);

    const responses = await getResponsesForRespondent(pool, respondent.id);
    // Shared item stored exactly once, with no rated firm.
    const shared = responses.filter((r) => r.questionId === 'S4-P1');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.ratedFirmId).toBeNull();

    // Firm-specific answers are per-firm and NOT copied.
    const bAns = responses.find((r) => r.questionId === 'S4-Q1' && r.ratedFirmId === b.id);
    const cAns = responses.find((r) => r.questionId === 'S4-Q1' && r.ratedFirmId === c.id);
    expect((bAns?.answer as { a: unknown }).a).toBe(8);
    expect((cAns?.answer as { a: unknown }).a).toBe(5);
  });

  it('stores one shared row per respondent and one firm-specific row per rated firm', async () => {
    const b = await firm('firm-b');
    const c = await firm('firm-c');
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });

    await submitResponses(pool, {
      editionId,
      respondentId: respondent.id,
      sharedAnswers: { 'S4-P1': { a: 'Under ₦50,000' } },
      firmAnswers: {
        [b.id]: { 'S4-Q1': { a: 7 }, 'S4-Q2': { a: 6 } },
        [c.id]: { 'S4-Q1': { a: 9 }, 'S4-Q2': { a: 4 } },
      },
    });

    const responses = await getResponsesForRespondent(pool, respondent.id);
    expect(responses.filter((r) => r.scope === 'shared')).toHaveLength(1);
    expect(responses.filter((r) => r.scope === 'firm_specific')).toHaveLength(4);
  });
});

describe('Consent gate (S5a / S5b)', () => {
  it('refuses submission when consent is not accepted', async () => {
    const respondent = await createRespondent(pool, {
      editionId,
      instrumentCode: 'S5a',
      consentAccepted: false,
    });
    await expect(
      submitResponses(pool, {
        editionId,
        respondentId: respondent.id,
        sharedAnswers: { 'S5a-Q7': { a: 'Better' } },
        firmAnswers: {},
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    // Nothing was written.
    expect(await getResponsesForRespondent(pool, respondent.id)).toHaveLength(0);
  });

  it('allows submission once consent is accepted', async () => {
    const respondent = await createRespondent(pool, {
      editionId,
      instrumentCode: 'S5a',
      consentAccepted: true,
    });
    const written = await submitResponses(pool, {
      editionId,
      respondentId: respondent.id,
      sharedAnswers: { 'S5a-Q7': { a: 'Better' } },
      firmAnswers: {},
    });
    expect(written).toHaveLength(1);
  });
});

describe('Immutability', () => {
  it('rejects a duplicate answer for the same respondent/question/firm (no overwrite)', async () => {
    const b = await firm('firm-b');
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    await submitResponses(pool, {
      editionId,
      respondentId: respondent.id,
      sharedAnswers: {},
      firmAnswers: { [b.id]: { 'S4-Q1': { a: 8 } } },
    });
    await expect(
      submitResponses(pool, {
        editionId,
        respondentId: respondent.id,
        sharedAnswers: {},
        firmAnswers: { [b.id]: { 'S4-Q1': { a: 3 } } },
      }),
    ).rejects.toThrow();
  });

  it('the DB blocks UPDATE of a stored response', async () => {
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    const [written] = await submitResponses(pool, {
      editionId,
      respondentId: respondent.id,
      sharedAnswers: { 'S4-P1': { a: 'Under ₦50,000' } },
      firmAnswers: {},
    });
    await expect(
      pool.query(`UPDATE responses SET answer = '{"a":"x"}' WHERE id = $1`, [written?.id]),
    ).rejects.toThrow(/responses are immutable/);
  });
});
