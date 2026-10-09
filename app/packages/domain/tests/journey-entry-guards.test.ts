/**
 * Server-side guards on the public respondent journey (E2E 2026-10-09):
 *  - D33: once an edition's results are locked, no entry route may start a
 *    journey and an in-progress journey can no longer be answered or
 *    submitted.
 *  - D1: a regulator / market-infrastructure review (I-SEC, I-NGX, I-CSCS,
 *    I-DEP) can only be answered through the link issued to its named
 *    contact — it can never be self-started.
 *  - D6: the public consent copy carries no internal governance note.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  upsertEditionParticipation,
  updateEditionStatus,
  getInstrumentItems,
  getRespondentById,
  getResponsesForRespondent,
  listInstitutions,
  setConfig,
} from '@cis/db';
import {
  seedReferenceData,
  startJourney,
  registerContact,
  setRatedFirms,
  saveDraftAnswer,
  submitJourney,
  createReferral,
  createColleagueInvite,
  getResumeByToken,
  saveContact,
  issueSurveyLink,
  getSeats,
  assignSeat,
  startSeatEntry,
  getPublicConsentContent,
  isRegulatorInstrument,
  CollectionClosedError,
  RegulatorLinkRequiredError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';
import { answerAll } from './helpers/answers';

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
  await updateEditionStatus(pool, editionId, 'open');
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
  await upsertEditionParticipation(pool, { editionId, organizationId: org.id, status: 'active' });
  return org;
}

describe('D33 — collection closed: nothing new starts once results are locked', () => {
  it.each(['locked', 'archived'] as const)(
    'refuses every self-started route when the edition is %s',
    async (status) => {
      const firm = await activeFirm('closed-firm');
      await updateEditionStatus(pool, editionId, status);

      // Public retail, institutional investor, outreach-link (recruiting firm).
      for (const instrumentCode of ['S4', 'S5a', 'S5b']) {
        await expect(startJourney(pool, { editionId, instrumentCode })).rejects.toBeInstanceOf(
          CollectionClosedError,
        );
      }
      await expect(
        startJourney(pool, { editionId, instrumentCode: 'S4', recruitingFirmId: firm.id }),
      ).rejects.toBeInstanceOf(CollectionClosedError);
      // Colleague invite (the referral route is covered below).
      await expect(
        createColleagueInvite(pool, { editionId, instrumentCode: 'S5a', institutionName: 'Acme' }),
      ).rejects.toBeInstanceOf(CollectionClosedError);
    },
  );

  it('an in-progress survey can no longer be answered or submitted after the lock', async () => {
    const firm = await activeFirm('in-flight-firm');
    const r = await startJourney(pool, { editionId, instrumentCode: 'S4' });
    await registerContact(pool, r.id, { consentAccepted: true, channel: 'none' });
    await setRatedFirms(pool, r.id, [firm.id]);
    await answerAll(pool, r.id, await getInstrumentItems(pool, 'S4'), [firm.id]);

    await updateEditionStatus(pool, editionId, 'locked');

    await expect(submitJourney(pool, r.id)).rejects.toBeInstanceOf(CollectionClosedError);
    await expect(
      saveDraftAnswer(pool, r.id, { questionId: 'S4-P1', ratedFirmId: null, answer: { a: 'x' } }),
    ).rejects.toBeInstanceOf(CollectionClosedError);
    await expect(setRatedFirms(pool, r.id, [firm.id])).rejects.toBeInstanceOf(
      CollectionClosedError,
    );
    await expect(
      registerContact(pool, r.id, { consentAccepted: true, channel: 'none' }),
    ).rejects.toBeInstanceOf(CollectionClosedError);
    await expect(
      createReferral(pool, { editionId, instrumentCode: 'S4', referredByRespondentId: r.id }),
    ).rejects.toBeInstanceOf(CollectionClosedError);

    // Nothing reached the frozen dataset.
    expect(await getResponsesForRespondent(pool, r.id)).toHaveLength(0);
    expect((await getRespondentById(pool, r.id))?.submittedAt).toBeNull();
  });

  it('a firm seat link can neither start nor resume once collection has closed', async () => {
    const org = await activeFirm('seat-firm');
    await getSeats(pool, editionId, org.id);
    const seat = await assignSeat(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S1',
      assignedName: 'Jane MD',
      assignedEmail: 'jane@seat-firm.example',
    });
    await updateEditionStatus(pool, editionId, 'locked');
    await expect(startSeatEntry(pool, seat.linkToken)).rejects.toBeInstanceOf(
      CollectionClosedError,
    );
  });

  it('still accepts a full survey while the edition is open (batched submit writes every row)', async () => {
    const b = await activeFirm('open-b');
    const c = await activeFirm('open-c');
    const r = await startJourney(pool, { editionId, instrumentCode: 'S4' });
    await registerContact(pool, r.id, { consentAccepted: true, channel: 'none' });
    await setRatedFirms(pool, r.id, [b.id, c.id]);
    const items = await getInstrumentItems(pool, 'S4');
    await answerAll(pool, r.id, items, [b.id, c.id]);
    const written = await submitJourney(pool, r.id);
    const shared = items.filter((i) => i.scope === 'shared').length;
    const perFirm = items.filter((i) => i.scope === 'firm_specific').length;
    expect(written).toHaveLength(shared + perFirm * 2);
    expect(await getResponsesForRespondent(pool, r.id)).toHaveLength(shared + perFirm * 2);
  });
});

describe('D1 — regulator reviews open only through the issued named-contact link', () => {
  it('knows exactly the four institution-family instruments', () => {
    for (const code of ['I-SEC', 'I-NGX', 'I-CSCS', 'I-DEP']) {
      expect(isRegulatorInstrument(code)).toBe(true);
    }
    for (const code of ['S1', 'S2', 'S3', 'S4', 'S5a', 'S5b']) {
      expect(isRegulatorInstrument(code)).toBe(false);
    }
  });

  it.each(['I-SEC', 'I-NGX', 'I-CSCS', 'I-DEP'])(
    'refuses to self-start %s (public start or colleague invite)',
    async (instrumentCode) => {
      await expect(
        startJourney(pool, { editionId, instrumentCode, institutionName: 'SEC' }),
      ).rejects.toBeInstanceOf(RegulatorLinkRequiredError);
      await expect(
        createColleagueInvite(pool, { editionId, instrumentCode, institutionName: 'SEC' }),
      ).rejects.toBeInstanceOf(RegulatorLinkRequiredError);
    },
  );

  it('the issued link still opens, answers and submits the review', async () => {
    const institutions = await listInstitutions(pool);
    const sec = institutions.find((i) => i.name === 'Securities and Exchange Commission')!.id;
    await saveContact(pool, editionId, sec, 'A', {
      who: 'Hauwa Ibrahim',
      role: 'Director, Market Supervision',
      email: 'h.ibrahim@sec.example',
      phone: '+234 803 221 4470',
      how: 'Introduced by the Registrar',
    });
    const view = await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-11-01' });
    const token = view.surveyLink!.split('/').pop()!;
    const resume = await getResumeByToken(pool, token);
    const respondentId = resume!.respondent.id;
    await answerAll(pool, respondentId, await getInstrumentItems(pool, 'I-SEC'), []);
    const written = await submitJourney(pool, respondentId);
    expect(written.length).toBeGreaterThan(0);
  });
});

describe('D6 — the public consent copy carries no internal note', () => {
  it('sends only the four respondent-facing fields, whatever else the config holds', async () => {
    await setConfig(pool, 'consent.pat011', {
      provisional: true,
      note: 'Owned by the DPO — internal.',
      notice: 'N',
      expansionTitle: 'T',
      expansion: 'E',
      checkboxLabel: 'C',
    });
    const { consent } = await getPublicConsentContent(pool);
    expect(consent).toEqual({
      notice: 'N',
      expansionTitle: 'T',
      expansion: 'E',
      checkboxLabel: 'C',
    });
  });
});
