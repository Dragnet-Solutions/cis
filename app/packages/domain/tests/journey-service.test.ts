/**
 * Journey orchestration integration tests (real Postgres). Covers Phase 3 DoD:
 *  - S4 multi-firm sequencing: shared items once, firm-specific per rated firm,
 *    frozen into immutable responses on submit.
 *  - Visibility boundary: the firm-facing accessor returns completion STATUS
 *    only — never an answer — under any parameter.
 *  - Outreach non-joinability: the outreach table has no respondent/response
 *    key, so a firm's outreach view cannot correlate to a response.
 *  - Referral / colleague attribution: neither inherits the inviter's source
 *    (recruiting) firm; a colleague carries institution name and no inviter link.
 *  - Resume restores exact firm context mid-loop.
 *  - Consent gate enforced server-side (PAT-011 and submit).
 *  - Review-before-submit: an incomplete journey cannot be submitted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  upsertEditionParticipation,
  getInstrumentItems,
  getFirmRespondentStatuses,
  getFirmOutreachSummary,
  createOutreachLink,
  incrementOutreach,
  getResponsesForRespondent,
  getRespondentById,
} from '@cis/db';
import { buildJourneySequence, firmContextAt } from '@cis/survey';
import {
  seedReferenceData,
  startJourney,
  registerContact,
  setRatedFirms,
  saveDraftAnswer,
  getResume,
  submitJourney,
  createReferral,
  createColleagueInvite,
  ConsentRequiredError,
  ReviewGapError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';
import { answerAll, validAnswerFor } from './helpers/answers';

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

async function activeFirm(slug: string) {
  const org = await createOrganization(pool, {
    slug,
    displayName: slug.toUpperCase(),
    orgType: 'firm',
  });
  await upsertEditionParticipation(pool, {
    editionId,
    organizationId: org.id,
    status: 'active',
  });
  return org;
}

describe('S4 multi-firm journey → immutable responses', () => {
  it('freezes shared items once and firm-specific items once per rated firm', async () => {
    const b = await activeFirm('firm-b');
    const c = await activeFirm('firm-c');
    const r = await startJourney(pool, { editionId, instrumentCode: 'S4' });
    await setRatedFirms(pool, r.id, [b.id, c.id]);

    const items = await getInstrumentItems(pool, 'S4');
    await answerAll(pool, r.id, items, [b.id, c.id]);
    const written = await submitJourney(pool, r.id);

    const shared = items.filter((i) => i.scope === 'shared');
    const perFirm = items.filter((i) => i.scope === 'firm_specific');
    expect(written.length).toBe(shared.length + perFirm.length * 2);

    const responses = await getResponsesForRespondent(pool, r.id);
    // Every shared item: exactly one row, no rated firm.
    for (const s of shared) {
      const rows = responses.filter((x) => x.questionId === s.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ratedFirmId).toBeNull();
    }
    // Every firm-specific item: exactly one row per rated firm.
    for (const p of perFirm) {
      const rows = responses.filter((x) => x.questionId === p.id);
      expect(rows.map((x) => x.ratedFirmId).sort()).toEqual([b.id, c.id].sort());
    }
  });
});

describe('Review-before-submit gate', () => {
  it('refuses to submit while a required item is unanswered, and names the gap', async () => {
    const b = await activeFirm('firm-b');
    const r = await startJourney(pool, { editionId, instrumentCode: 'S4' });
    await setRatedFirms(pool, r.id, [b.id]);

    const items = await getInstrumentItems(pool, 'S4');
    const sequence = buildJourneySequence(items, [b.id]);
    // Answer all but the last step.
    for (const s of sequence.slice(0, -1)) {
      await saveDraftAnswer(pool, r.id, {
        questionId: s.item.id,
        ratedFirmId: s.ratedFirmId,
        answer: validAnswerFor(s.item),
      });
    }
    await expect(submitJourney(pool, r.id)).rejects.toBeInstanceOf(ReviewGapError);
    expect(await getResponsesForRespondent(pool, r.id)).toHaveLength(0);
  });
});

describe('Consent gate (server-side, PAT-011)', () => {
  it('registerContact refuses to proceed without accepted consent', async () => {
    const r = await startJourney(pool, { editionId, instrumentCode: 'S5a' });
    await expect(
      registerContact(pool, r.id, { consentAccepted: false, channel: 'none' }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('registerContact mints a recovery token once consent is accepted', async () => {
    const r = await startJourney(pool, { editionId, instrumentCode: 'S5a' });
    const updated = await registerContact(pool, r.id, {
      consentAccepted: true,
      channel: 'email',
      email: 'someone@example.com',
    });
    expect(updated.consentAccepted).toBe(true);
    expect(updated.recoveryToken).toBeTruthy();
    expect(updated.contactEmail).toBe('someone@example.com');
  });

  it('submit refuses a consent-required instrument until consent is accepted', async () => {
    const r = await startJourney(pool, { editionId, instrumentCode: 'S5a' });
    const items = await getInstrumentItems(pool, 'S5a');
    await answerAll(pool, r.id, items, []);
    await expect(submitJourney(pool, r.id)).rejects.toBeInstanceOf(ConsentRequiredError);

    await registerContact(pool, r.id, { consentAccepted: true, channel: 'none' });
    const written = await submitJourney(pool, r.id);
    expect(written.length).toBeGreaterThan(0);
  });
});

describe('Resume restores exact firm context mid-loop', () => {
  it('reports which rated firm was being answered, not just the step number', async () => {
    const b = await activeFirm('firm-b');
    const c = await activeFirm('firm-c');
    const r = await startJourney(pool, { editionId, instrumentCode: 'S4' });
    await setRatedFirms(pool, r.id, [b.id, c.id]);

    const items = await getInstrumentItems(pool, 'S4');
    const sequence = buildJourneySequence(items, [b.id, c.id]);
    // Find a step that is firm-specific for the SECOND firm (c).
    const targetIndex = sequence.findIndex((s) => s.ratedFirmId === c.id);
    expect(targetIndex).toBeGreaterThan(-1);

    // Answer up to (and including) that step, leaving resume_step there.
    for (let i = 0; i <= targetIndex; i += 1) {
      const s = sequence[i]!;
      await saveDraftAnswer(pool, r.id, {
        questionId: s.item.id,
        ratedFirmId: s.ratedFirmId,
        answer: validAnswerFor(s.item),
        step: i,
      });
    }

    const state = await getResume(pool, r.id);
    expect(state.firmContext.ratedFirmId).toBe(c.id);
    expect(firmContextAt(sequence, targetIndex).ratedFirmId).toBe(c.id);
    expect(state.drafts.length).toBe(targetIndex + 1);
  });
});

describe('Visibility boundary (firm sees status, never answers)', () => {
  it('the firm-facing accessor returns completion status only, with no answer content', async () => {
    const recruiter = await activeFirm('recruiter-firm');
    const b = await activeFirm('rated-firm-b');
    const r = await startJourney(pool, {
      editionId,
      instrumentCode: 'S4',
      recruitingFirmId: recruiter.id,
    });
    await setRatedFirms(pool, r.id, [b.id]);
    const items = await getInstrumentItems(pool, 'S4');
    await answerAll(pool, r.id, items, [b.id]);
    await submitJourney(pool, r.id);

    const statuses = await getFirmRespondentStatuses(pool, editionId, recruiter.id);
    expect(statuses).toHaveLength(1);
    const only = statuses[0]!;
    expect(only.submitted).toBe(true);
    expect(only.instrumentCode).toBe('S4');
    // The status row carries NO answer field of any shape.
    expect(Object.keys(only).sort()).toEqual(['instrumentCode', 'respondentId', 'submitted']);

    // The rated firm (b) is not the recruiter — it gets no respondent row here,
    // proving this accessor is keyed by recruiting firm, not by rated firm.
    expect(await getFirmRespondentStatuses(pool, editionId, b.id)).toHaveLength(0);
  });
});

describe('Outreach non-joinability', () => {
  it('exposes counts only and has no column that references a respondent or response', async () => {
    const firmOrg = await activeFirm('outreach-firm');
    await createOutreachLink(pool, { editionId, organizationId: firmOrg.id, token: 'tok-1' });
    await incrementOutreach(pool, 'tok-1', 'opens');
    await incrementOutreach(pool, 'tok-1', 'starts');

    const summary = await getFirmOutreachSummary(pool, editionId, firmOrg.id);
    expect(summary).toEqual({ links: 1, opens: 1, starts: 1, finishes: 0 });

    // Structural proof: outreach_links has no respondent/response foreign key.
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'outreach_links'`,
    );
    const names = cols.rows.map((x) => x.column_name);
    expect(names).not.toContain('respondent_id');
    expect(names).not.toContain('response_id');
  });
});

describe('Attribution: referral / colleague never inherit source firm', () => {
  it('a referral starts an independent journey with no recruiting firm', async () => {
    const recruiter = await activeFirm('referrer-recruiter');
    const referrer = await startJourney(pool, {
      editionId,
      instrumentCode: 'S4',
      recruitingFirmId: recruiter.id,
    });

    const referred = await createReferral(pool, {
      editionId,
      instrumentCode: 'S4',
      referredByRespondentId: referrer.id,
    });

    const fresh = await getRespondentById(pool, referred.id);
    expect(fresh?.recruitingFirmId).toBeNull();
    expect(fresh?.referredByRespondentId).toBe(referrer.id);
    // The referrer's recruiting firm is NEVER copied onto the referred journey.
    expect(fresh?.recruitingFirmId).not.toBe(recruiter.id);
  });

  it('a colleague invite carries institution name only, with no inviter link and no firm', async () => {
    const colleague = await createColleagueInvite(pool, {
      editionId,
      instrumentCode: 'I-SEC',
      institutionName: 'Acme Capital',
    });
    const fresh = await getRespondentById(pool, colleague.id);
    expect(fresh?.recruitingFirmId).toBeNull();
    expect(fresh?.referredByRespondentId).toBeNull();
    expect(fresh?.institutionName).toBe('Acme Capital');
  });
});
