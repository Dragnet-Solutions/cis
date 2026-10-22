/**
 * D-04 — the published Industry report is emailed to every investor who asked
 * for it by email: once per publication, never to someone who did not ask,
 * has no address, has not submitted, withdrew or opted out. Retrying sends
 * only to anyone not yet sent it, and the send is in the audit trail.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  ensureSeats,
  setSeatState,
  createCalculationRun,
  insertCalculatedResult,
  createNationalReport,
  approveNationalReport,
  createRespondent,
  type ReportPublication,
} from '@cis/db';
import {
  seedReferenceData,
  requestSignoff,
  approveSignoff,
  publishIndustryReport,
  sendPublishedReportToInvestors,
  reportEmailedCount,
  optOutOfReport,
  REPORT_PUBLISHED_EMAIL_KIND,
  type NarrativeModel,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';
import { approveMethodologyForTests } from '../../db/tests/methodology-approval';

const PORTAL = 'https://cis.example.ng/firm';

let pool: Pool;
let editionId: string;
let firmId: string;
let operatorId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  await approveMethodologyForTests(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  operatorId = seed.makerUserId;
  const org = await createOrganization(pool, {
    slug: 'delivery-firm',
    displayName: 'Delivery Firm',
    orgType: 'firm',
  });
  firmId = org.id;
  await ensureSeats(pool, editionId, firmId);
  await setSeatState(pool, {
    editionId,
    organizationId: firmId,
    seatCode: 'S1',
    state: 'complete',
  });
});
afterAll(async () => {
  await closeTestPool();
});

async function signedRun(): Promise<string> {
  const run = await createCalculationRun(pool, {
    editionId,
    runType: 'scoring',
    datasetHash: 'ds-delivery',
  });
  await insertCalculatedResult(pool, {
    calculationRunId: run.id,
    subjectType: 'market',
    subjectId: 'INDUSTRY',
    metricCode: 'OMI',
    value: 55,
    n: 100,
    denominator: 100,
    sufficiencyState: 'REPORTABLE',
  });
  const so = await requestSignoff(pool, {
    editionId,
    calculationRunId: run.id,
    requestedBy: 'maker',
    checkedAccount: {
      populationCountsReviewed: true,
      floorStatusReviewed: true,
      dataQualityFlagsReviewed: true,
    },
  });
  await approveSignoff(pool, { signoffId: so.id, approvedBy: 'checker' });
  return run.id;
}

async function publish(): Promise<ReportPublication> {
  const runId = await signedRun();
  const nr = await createNationalReport(pool, { editionId, scoringRunId: runId });
  await approveNationalReport(pool, nr.id, 'checker');
  const model: NarrativeModel = {
    name: 'fake-model',
    complete: async () =>
      JSON.stringify({
        sections: { EXEC: [{ text: 'The published analysis.', factIds: ['PART.firm'] }] },
      }),
  };
  return publishIndustryReport(pool, editionId, () => model, 'op@cis.example');
}

/** An investor with the given report-delivery choice. */
async function investor(
  code: 'S4' | 'S5a' | 'S5b',
  delivery: string | null,
  email: string | null,
  opts: { submitted?: boolean; withdrawn?: boolean } = {},
): Promise<{ id: string; token: string }> {
  const r = await createRespondent(pool, {
    editionId,
    instrumentCode: code,
    consentAccepted: true,
  });
  const token = `tok-${r.id}`;
  await pool.query(
    `UPDATE respondents
        SET report_delivery = $2, contact_email = $3, recovery_token = $4,
            contact_channel = $5,
            submitted_at = CASE WHEN $6 THEN NOW() ELSE NULL END,
            withdrawn_at = CASE WHEN $7 THEN NOW() ELSE NULL END
      WHERE id = $1`,
    [
      r.id,
      delivery,
      email,
      token,
      delivery === 'email' || delivery === 'both' || delivery === 'text' ? delivery : 'none',
      opts.submitted ?? true,
      opts.withdrawn ?? false,
    ],
  );
  return { id: r.id, token };
}

interface OutboxRow {
  ref_id: string;
  to_address: string;
  subject: string;
  body_text: string;
  body_html: string;
}
const outbox = async () =>
  (
    await pool.query<OutboxRow>(
      `SELECT ref_id, to_address, subject, body_text, body_html FROM email_outbox
        WHERE kind = $1 ORDER BY to_address`,
      [REPORT_PUBLISHED_EMAIL_KIND],
    )
  ).rows;

const audits = async () =>
  (
    await pool.query<{ actor_id: string; entity_id: string; new_value: { count: number } }>(
      `SELECT actor_id, entity_id, new_value FROM audit_log
        WHERE action_type = 'report_delivery.sent' ORDER BY occurred_at`,
    )
  ).rows;

describe('The published report goes to the investors who asked for it', () => {
  it('emails each opted-in investor once, and no one else', async () => {
    const retail = await investor('S4', 'email', 'ada@example.ng');
    const inst = await investor('S5a', 'both', ' fund@example.ng ');
    const s5b = await investor('S5b', 'email', 'desk@example.ng');
    await investor('S4', 'none', 'nope@example.ng'); // did not opt in
    await investor('S4', 'text', 'sms@example.ng'); // asked by text only
    await investor('S4', 'email', null); // no address
    await investor('S4', 'email', 'not-an-address'); // no usable address
    await investor('S4', 'email', 'draft@example.ng', { submitted: false }); // never submitted
    await investor('S4', 'email', 'gone@example.ng', { withdrawn: true }); // withdrew
    const optedOut = await investor('S4', 'email', 'optout@example.ng');
    expect(await optOutOfReport(pool, optedOut.token)).toBe(true); // has since opted out

    const publication = await publish();
    const actor = { userId: operatorId, ipAddress: '10.0.0.1', userAgent: 'vitest' };
    // A batch of 1 exercises the batching loop.
    const sent = await sendPublishedReportToInvestors(pool, publication, {
      portalUrl: PORTAL,
      supportEmail: 'help@idhub.example',
      actor,
      batchSize: 1,
    });
    expect(sent).toBe(3);

    const rows = await outbox();
    expect(rows.map((r) => r.to_address)).toEqual([
      'ada@example.ng',
      'desk@example.ng',
      'fund@example.ng',
    ]);
    expect(rows.map((r) => r.ref_id).sort()).toEqual([retail.id, inst.id, s5b.id].sort());

    // The approved P-05: one link, to the published report.
    const ada = rows[0]!;
    expect(ada.subject).toBe('The 2026 State of Stockbroking report is published');
    expect(ada.body_text).toContain(
      `Read the report:\nhttps://cis.example.ng/reports/industry?edition=${editionId}`,
    );
    expect(ada.body_text).toContain('Thank you again for taking part');
    expect(ada.body_text).toContain('help@idhub.example');
    expect(ada.body_text).toContain(
      `https://cis.example.ng/reports/institutional?edition=${editionId}`,
    );
    expect(ada.body_text).toContain(`opt out here (https://cis.example.ng/survey?noReport=`);
    expect(ada.body_html).toContain('Read the report');
    // A link only — never an answer or a figure.
    expect(ada.body_text).not.toMatch(/\b55\b/);

    // Again (a retry, or the publish route called a second time): nothing new.
    expect(
      await sendPublishedReportToInvestors(pool, publication, { portalUrl: PORTAL, actor }),
    ).toBe(0);
    expect(await outbox()).toHaveLength(3);
    expect(await reportEmailedCount(pool, publication.id)).toBe(3);

    // One audit entry for the send, with the count, from the operator.
    const audit = await audits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: operatorId,
      entity_id: publication.id,
      new_value: { count: 3 },
    });
  });

  it('a retry reaches only an investor who asked after the first send', async () => {
    await investor('S4', 'email', 'first@example.ng');
    const publication = await publish();
    expect(await sendPublishedReportToInvestors(pool, publication, { portalUrl: PORTAL })).toBe(1);
    await investor('S4', 'email', 'later@example.ng');
    expect(await sendPublishedReportToInvestors(pool, publication, { portalUrl: PORTAL })).toBe(1);
    expect((await outbox()).map((r) => r.to_address)).toEqual([
      'first@example.ng',
      'later@example.ng',
    ]);
    expect((await audits()).map((a) => a.new_value.count)).toEqual([1, 1]);
  });

  it('concurrent sends never email anyone twice', async () => {
    for (let i = 0; i < 12; i += 1) await investor('S4', 'email', `inv${i}@example.ng`);
    const publication = await publish();
    const counts = await Promise.all([
      sendPublishedReportToInvestors(pool, publication, { portalUrl: PORTAL, batchSize: 5 }),
      sendPublishedReportToInvestors(pool, publication, { portalUrl: PORTAL, batchSize: 5 }),
    ]);
    // Anyone a racing call skipped is picked up by the next call.
    await sendPublishedReportToInvestors(pool, publication, { portalUrl: PORTAL });
    const rows = await outbox();
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.to_address)).size).toBe(12);
    expect(counts[0]! + counts[1]!).toBeLessThanOrEqual(12);
  });

  it('the ledger allows one row per publication and respondent (migration in place)', async () => {
    const { id } = await investor('S4', 'email', 'one@example.ng');
    const publication = await publish();
    await pool.query(
      `INSERT INTO report_delivery_sends (publication_id, respondent_id) VALUES ($1, $2)`,
      [publication.id, id],
    );
    await expect(
      pool.query(
        `INSERT INTO report_delivery_sends (publication_id, respondent_id) VALUES ($1, $2)`,
        [publication.id, id],
      ),
    ).rejects.toThrow(/duplicate key/);
    // Already in the ledger, so no email.
    expect(await sendPublishedReportToInvestors(pool, publication, { portalUrl: PORTAL })).toBe(0);
  });
});
