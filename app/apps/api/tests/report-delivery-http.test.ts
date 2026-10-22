/**
 * D-04 over HTTP: publishing the Industry report (POST
 * /editions/:id/reports/industry/publish) emails it to the investors who asked
 * for it, says how many, and never emails anyone twice when called again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  createCalculationRun,
  insertCalculatedResult,
  createNationalReport,
  approveNationalReport,
  createRespondent,
} from '@cis/db';
import {
  seedReferenceData,
  requestSignoff,
  approveSignoff,
  publishIndustryReport,
  REPORT_PUBLISHED_EMAIL_KIND,
  type NarrativeModel,
} from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';
import { approveMethodologyForTests } from '../../../packages/db/tests/methodology-approval';

const PASSWORD = 'ChangeMe!2026';
const OPERATOR = 'adaeze.okoro@cis.example';

let app: FastifyInstance;
let editionId: string;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  await approveMethodologyForTests(getTestPool());
  editionId = (await seedReferenceData(getPool())).editionId;
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: OPERATOR, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

/** Published (as on approval) with a stand-in model, so no AI is called. */
async function published(): Promise<void> {
  const pool = getPool();
  const run = await createCalculationRun(pool, {
    editionId,
    runType: 'scoring',
    datasetHash: 'ds-delivery-http',
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
  const nr = await createNationalReport(pool, { editionId, scoringRunId: run.id });
  await approveNationalReport(pool, nr.id, 'checker');
  const model: NarrativeModel = {
    name: 'fake-model',
    complete: async () =>
      JSON.stringify({ sections: { EXEC: [{ text: 'Analysis.', factIds: ['PART.firm'] }] } }),
  };
  await publishIndustryReport(pool, editionId, () => model, OPERATOR);
}

async function investor(delivery: string, email: string | null): Promise<string> {
  const r = await createRespondent(getPool(), {
    editionId,
    instrumentCode: 'S4',
    consentAccepted: true,
  });
  await getPool().query(
    `UPDATE respondents SET report_delivery = $2, contact_email = $3, submitted_at = NOW()
      WHERE id = $1`,
    [r.id, delivery, email],
  );
  return r.id;
}

const outbox = async () =>
  (
    await getPool().query<{ ref_id: string; to_address: string }>(
      `SELECT ref_id, to_address FROM email_outbox WHERE kind = $1`,
      [REPORT_PUBLISHED_EMAIL_KIND],
    )
  ).rows;

describe('POST /editions/:id/reports/industry/publish — the report to investors who asked', () => {
  it('emails the opted-in investor once, and reports the count', async () => {
    const wanted = await investor('email', 'qa.optin@example.ng');
    await investor('none', 'qa.optout@example.ng');
    await investor('email', null);
    await published();
    const token = await login();
    const publish = () =>
      app.inject({
        method: 'POST',
        url: `/editions/${editionId}/reports/industry/publish`,
        headers: { authorization: `Bearer ${token}` },
      });

    const first = await publish();
    expect(first.statusCode).toBe(200);
    expect(first.json<{ reportEmailed: number }>().reportEmailed).toBe(1);
    expect(await outbox()).toEqual([{ ref_id: wanted, to_address: 'qa.optin@example.ng' }]);

    const again = await publish();
    expect(again.statusCode).toBe(200);
    expect(again.json<{ reportEmailed: number }>().reportEmailed).toBe(1);
    expect(await outbox()).toHaveLength(1);

    const audit = await getPool().query<{ new_value: { count: number } }>(
      `SELECT new_value FROM audit_log WHERE action_type = 'report_delivery.sent'`,
    );
    expect(audit.rows.map((r) => r.new_value.count)).toEqual([1]);

    const view = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/reports/industry`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(view.json<{ reportEmailedCount: number | null }>().reportEmailedCount).toBe(1);
  });
});
