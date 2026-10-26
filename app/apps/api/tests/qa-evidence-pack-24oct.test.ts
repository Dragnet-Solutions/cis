/**
 * The QA evidence pack (24–25 Oct) over real HTTP:
 *  - #2: once collection has ended, the firm directory import and seat
 *    assignment refuse with the same 403 CollectionClosedError the journeys use;
 *  - E01: an import must name the edition, so a firm can never be created
 *    without being enrolled (and so invisible to its own clients);
 *  - #9: the national report counts every market institution taking part, not
 *    a fixed three;
 *  - E03: "Create next edition" sees an edition that already follows this one.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  createOrganization,
  upsertEditionParticipation,
  updateEditionStatus,
  listOrganizations,
  createCalculationRun,
} from '@cis/db';
import {
  createLeadCoordinator,
  setCoordinatorPin,
  seedReferenceData,
  requestSignoff,
  approveSignoff,
  listRegulators,
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
const MAKER = 'adaeze.okoro@cis.example';
const LEAD = 'lead@locked-firm.example';

let app: FastifyInstance;
let editionId: string;
let orgId: string;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  editionId = (await seedReferenceData(getPool())).editionId;
  await approveMethodologyForTests(getTestPool());
  await updateEditionStatus(getPool(), editionId, 'open');
  const org = await createOrganization(getPool(), {
    slug: 'locked-firm',
    displayName: 'Locked Firm',
    orgType: 'firm',
  });
  orgId = org.id;
  await upsertEditionParticipation(getPool(), {
    editionId,
    organizationId: orgId,
    status: 'active',
  });
  const lead = await createLeadCoordinator(getPool(), {
    organizationId: orgId,
    name: 'Lead One',
    email: LEAD,
  });
  await setCoordinatorPin(getPool(), lead.id, { newPin: '1234' });
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

async function operator(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: MAKER, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

async function coordinator(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/portal/auth/login',
    payload: { email: LEAD, pin: '1234' },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function firmCount(): Promise<number> {
  return (await listOrganizations(getPool())).filter((o) => o.orgType === 'firm').length;
}

describe('#2 — a locked edition refuses directory and seat writes', () => {
  it('seat assignment returns 403 CollectionClosedError once results are locked', async () => {
    const token = await coordinator();
    await updateEditionStatus(getPool(), editionId, 'locked');
    const res = await app.inject({
      method: 'POST',
      url: '/portal/seats/S2/assign',
      headers: bearer(token),
      payload: { assignedName: 'Chidi Compliance', assignedEmail: 'chidi@locked-firm.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('CollectionClosedError');
    const seats = await app.inject({ method: 'GET', url: '/portal/seats', headers: bearer(token) });
    const s2 = seats
      .json<{ seats: Array<{ seatCode: string; state: string }> }>()
      .seats.find((s) => s.seatCode === 'S2');
    expect(s2?.state ?? 'empty').toBe('empty');
  });

  it('replacing a seat holder is refused the same way', async () => {
    const token = await coordinator();
    const assigned = await app.inject({
      method: 'POST',
      url: '/portal/seats/S2/assign',
      headers: bearer(token),
      payload: { assignedName: 'Chidi Compliance', assignedEmail: 'chidi@locked-firm.example' },
    });
    expect(assigned.statusCode).toBe(200);
    await updateEditionStatus(getPool(), editionId, 'locked');
    const res = await app.inject({
      method: 'POST',
      url: '/portal/seats/S2/replace',
      headers: bearer(token),
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('CollectionClosedError');
  });

  it('the operator’s seat assignment is refused the same way', async () => {
    const token = await operator();
    await updateEditionStatus(getPool(), editionId, 'locked');
    const res = await app.inject({
      method: 'POST',
      url: `/firm/${orgId}/editions/${editionId}/seats/S3/assign`,
      headers: bearer(token),
      payload: { assignedName: 'Ola Ops', assignedEmail: 'ola@locked-firm.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('CollectionClosedError');
  });

  it('the firm import returns 403 CollectionClosedError and adds nothing', async () => {
    const token = await operator();
    await updateEditionStatus(getPool(), editionId, 'locked');
    const before = await firmCount();
    const res = await app.inject({
      method: 'POST',
      url: '/firms/import',
      headers: bearer(token),
      payload: { csv: 'name\nLate Firm\n', dryRun: false, editionId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('CollectionClosedError');
    expect(await firmCount()).toBe(before);
  });

  it('while collecting, the same writes still work', async () => {
    const token = await operator();
    const res = await app.inject({
      method: 'POST',
      url: '/firms/import',
      headers: bearer(token),
      payload: { csv: 'name\nOn Time Firm\n', dryRun: false, editionId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ added: number; enrolled: number }>()).toMatchObject({
      added: 1,
      enrolled: 1,
    });
  });
});

describe('E01 — a firm import must name its edition', () => {
  it('a real import without editionId is refused with 400 and adds nothing', async () => {
    const token = await operator();
    const before = await firmCount();
    const res = await app.inject({
      method: 'POST',
      url: '/firms/import',
      headers: bearer(token),
      payload: { csv: 'name\nOrphan Firm\n', dryRun: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/edition/i);
    expect(await firmCount()).toBe(before);
  });
});

describe('#9 — Institutional Perspectives counts every market institution', () => {
  it('accepts the real number engaged and needs all of them', async () => {
    const pool = getPool();
    const required = new Set((await listRegulators(pool, editionId)).map((r) => r.institutionId))
      .size;
    expect(required).toBeGreaterThan(3);
    const run = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'ds-qa-regulators',
      status: 'complete',
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
    const token = await operator();
    const generate = (engaged: number) =>
      app.inject({
        method: 'POST',
        url: `/editions/${editionId}/national-report`,
        headers: bearer(token),
        payload: { scoringRunId: run.id, context: { segments: {}, regulatorsEngaged: engaged } },
      });
    const section = (res: Awaited<ReturnType<typeof generate>>) =>
      res
        .json<{
          sections: Array<{ sectionId: string; disposition: string; reason: string | null }>;
        }>()
        .sections.find((s) => s.sectionId.includes('INSTITUTIONAL_PERSPECTIVES'))!;

    const all = await generate(required);
    expect(all.statusCode).toBe(201);
    expect(section(all).reason ?? '').not.toMatch(/ of 3 /);

    const three = await generate(3);
    expect(three.statusCode).toBe(201);
    expect(section(three).disposition).toBe('suppressed');
    expect(section(three).reason).toContain(`3 of ${required}`);
  });
});

describe('E03 — "Create next edition" sees an edition that already follows', () => {
  it('reports the existing next edition and refuses a duplicate', async () => {
    const token = await operator();
    // The next edition exists and is already open — not a draft.
    const pool = getPool();
    const hint = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/next`,
      headers: bearer(token),
    });
    const suggested = hint.json<{ suggestedLabel: string }>().suggestedLabel;
    await pool.query(
      `INSERT INTO editions (label, status, prior_edition_id) VALUES ($1, 'open', $2)`,
      [suggested, editionId],
    );
    await updateEditionStatus(pool, editionId, 'locked');

    const again = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/next`,
      headers: bearer(token),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ nextExists: string | null }>().nextExists).toBe(suggested);

    const create = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/next`,
      headers: bearer(token),
      payload: { label: `${suggested} again` },
    });
    expect(create.statusCode).toBe(409);
    const editions = await pool.query(`SELECT COUNT(*)::int AS n FROM editions`);
    expect(editions.rows[0].n).toBe(2);
  });
});
