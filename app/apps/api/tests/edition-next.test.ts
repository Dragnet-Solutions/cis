/**
 * D-15 — "Create next edition": a new DRAFT edition carrying this edition's
 * configuration (floors, templates, enrolled firms, institution roles, dates
 * +1 year) and none of its activity (responses, respondents, freeze
 * snapshots, critical actions, runs, …). The source is untouched, only one
 * draft may exist, the creation is audited, and the open edition stays the
 * one respondents and the admin land on.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createOrganization,
  createRespondent,
  createUser,
  initializePool,
  updateEditionStatus,
  upsertEditionParticipation,
  currentEditionOf,
} from '@cis/db';
import { hashPassword, loadRbacContext } from '@cis/auth';
import { seedReferenceData, requestFreeze, decideFreeze, nextEditionLabel } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';
const SETUP = 'adaeze.okoro@cis.example';

let app: FastifyInstance;
let editionId: string;
let makerId: string;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

async function tokenFor(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Every table with an edition_id column, read from the live schema. */
async function editionScopedTables(): Promise<string[]> {
  const res = await getTestPool().query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'edition_id' ORDER BY 1`,
  );
  return res.rows.map((r) => r.t);
}
async function countsFor(id: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await editionScopedTables()) {
    const r = await getTestPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${t} WHERE edition_id = $1`,
      [id],
    );
    out[t] = Number(r.rows[0]!.n);
  }
  return out;
}
async function snapshotOf(id: string) {
  const pool = getTestPool();
  return {
    edition: (await pool.query(`SELECT * FROM editions WHERE id = $1`, [id])).rows,
    counts: await countsFor(id),
  };
}

let firms: Record<string, string>;

beforeEach(async () => {
  const pool = getTestPool();
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  makerId = seed.makerUserId;

  // The source edition in use: frozen, open, with enrolled firms and activity.
  const maker = await loadRbacContext(pool, seed.makerUserId);
  const checker = await loadRbacContext(pool, seed.checkerUserId);
  const f = await requestFreeze(pool, maker, editionId, 'Freeze for launch');
  await decideFreeze(pool, checker, editionId, f.id, { approved: true });
  await pool.query(`UPDATE editions SET planned_open_at = '2026-10-01T00:00:00Z' WHERE id = $1`, [
    editionId,
  ]);
  await updateEditionStatus(pool, editionId, 'open');
  await pool.query(
    `UPDATE institution_engagement SET target_by = '2026-11-15', contact_who = 'Someone'
      WHERE edition_id = $1`,
    [editionId],
  );

  firms = {};
  for (const [slug, status] of [
    ['alpha', 'active'],
    ['bravo', 'invited'],
    ['charlie', 'withdrawn'],
    ['delta', 'active'],
  ] as const) {
    const org = await createOrganization(pool, {
      slug,
      displayName: `${slug} Securities`,
      orgType: 'firm',
    });
    firms[slug] = org.id;
    await upsertEditionParticipation(pool, { editionId, organizationId: org.id, status });
  }
  // delta has since left the register.
  await pool.query(`UPDATE organizations SET is_active = FALSE WHERE id = $1`, [firms['delta']]);
  await createRespondent(pool, { editionId, instrumentCode: 'I-RET', consentAccepted: true });
});

describe('D-15 — create the next edition', () => {
  it('suggests next year and creates a draft carrying the configuration only', async () => {
    const pool = getTestPool();
    const t = await tokenFor(SETUP);
    const before = await snapshotOf(editionId);

    const hint = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/next`,
      headers: auth(t),
    });
    expect(hint.json()).toEqual({ suggestedLabel: '2027', draftExists: null });

    const res = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/next`,
      headers: auth(t),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; label: string; status: string; copied: unknown }>();
    expect(created).toMatchObject({ label: '2027', status: 'draft' });

    // The new edition: draft, prior = source, dates a year on, not frozen.
    const detail = await app.inject({
      method: 'GET',
      url: `/editions/${created.id}`,
      headers: auth(t),
    });
    expect(detail.json()).toMatchObject({
      label: '2027',
      status: 'draft',
      frozen: false,
      surveyOpenAt: null,
      plannedOpenAt: '2027-10-01T00:00:00.000Z',
      surveyCloseAt: '2027-11-30T00:00:00.000Z',
      lockedAt: null,
      pendingLock: null,
    });
    const src = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}`,
      headers: auth(t),
    });
    expect(detail.json().floors).toEqual(src.json().floors);
    const prior = await pool.query(`SELECT prior_edition_id FROM editions WHERE id = $1`, [
      created.id,
    ]);
    expect(prior.rows[0].prior_edition_id).toBe(editionId);

    // Questionnaires: every current instrument, none frozen into the draft.
    const inst = await app.inject({
      method: 'GET',
      url: `/editions/${created.id}/instruments`,
      headers: auth(t),
    });
    const srcInst = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/instruments`,
      headers: auth(t),
    });
    expect(inst.json().frozen).toBe(false);
    expect(inst.json().instruments.map((i: { code: string }) => i.code)).toEqual(
      srcInst.json().instruments.map((i: { code: string }) => i.code),
    );
    expect(inst.json().instruments.every((i: { frozen: boolean }) => !i.frozen)).toBe(true);

    // Templates: same set, same wording.
    const tpl = async (id: string) =>
      (
        await pool.query(
          `SELECT name, subject, body, audience_kind, requires_code
             FROM message_templates WHERE edition_id = $1 ORDER BY name`,
          [id],
        )
      ).rows;
    expect(await tpl(created.id)).toEqual(await tpl(editionId));
    expect((await tpl(created.id)).length).toBeGreaterThan(0);

    // Firms: active register firms not withdrawn, enrolled active.
    const part = await pool.query(
      `SELECT organization_id, status FROM edition_participation WHERE edition_id = $1
        ORDER BY organization_id`,
      [created.id],
    );
    expect(part.rows).toEqual(
      [firms['alpha'], firms['bravo']]
        .sort()
        .map((organization_id) => ({ organization_id, status: 'active' })),
    );

    // Institution roles: one fresh row each, target date a year on, no contact.
    const eng = await pool.query(
      `SELECT status, target_by::text AS target_by, contact_who, survey_link, respondent_id
         FROM institution_engagement WHERE edition_id = $1`,
      [created.id],
    );
    const srcEng = await pool.query(`SELECT 1 FROM institution_engagement WHERE edition_id = $1`, [
      editionId,
    ]);
    expect(eng.rowCount).toBe(srcEng.rowCount);
    for (const r of eng.rows) {
      expect(r).toEqual({
        status: 'not_started',
        target_by: '2027-11-15',
        contact_who: null,
        survey_link: null,
        respondent_id: null,
      });
    }

    // Nothing else crosses: every other edition-scoped table is empty for the
    // draft (the creation's own audit row aside).
    const counts = await countsFor(created.id);
    const copiedTables = [
      'edition_sample_floors',
      'message_templates',
      'edition_participation',
      'institution_engagement',
      'audit_log',
    ];
    for (const [table, n] of Object.entries(counts)) {
      if (!copiedTables.includes(table)) expect(n, table).toBe(0);
    }
    expect(counts['audit_log']).toBe(1);
    expect(before.counts['respondents']).toBe(1);
    expect(before.counts['edition_instrument_snapshots']).toBeGreaterThan(0);

    // The source is unchanged.
    const after = await snapshotOf(editionId);
    expect(after.edition).toEqual(before.edition);
    expect({ ...after.counts, audit_log: 0 }).toEqual({ ...before.counts, audit_log: 0 });

    // Audited.
    const audit = await pool.query(
      `SELECT actor_id, entity_id, new_value FROM audit_log WHERE action_type = 'edition.next_created'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: makerId,
      entity_id: created.id,
      new_value: { label: '2027', sourceEditionId: editionId, copied: { participants: 2 } },
    });

    // The open 2026 edition stays the current one for respondents.
    const ctx = await app.inject({ method: 'GET', url: '/journeys/context' });
    expect(ctx.json()).toMatchObject({ editionId, editionLabel: '2026', collectionOpen: true });
  });

  it('takes an edited label', async () => {
    const t = await tokenFor(SETUP);
    const res = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/next`,
      headers: auth(t),
      payload: { label: '2027 pilot' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().label).toBe('2027 pilot');
  });

  it('refuses while a draft edition exists, and an existing label', async () => {
    const t = await tokenFor(SETUP);
    const first = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/next`,
      headers: auth(t),
      payload: {},
    });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/next`,
      headers: auth(t),
      payload: { label: '2028' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/2027 edition is already in draft/);
    const hint = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/next`,
      headers: auth(t),
    });
    expect(hint.json().draftExists).toBe('2027');

    await updateEditionStatus(getTestPool(), first.json().id, 'open');
    const dup = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/next`,
      headers: auth(t),
      payload: { label: '2026' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toMatch(/already exists/);
  });

  it('requires the setup right', async () => {
    const pool = getTestPool();
    await createUser(pool, {
      email: 'no.setup@cis.example',
      passwordHash: await hashPassword(PASSWORD),
      displayName: 'No Setup',
      organization: 'CIS',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/next`,
      headers: auth(await tokenFor('no.setup@cis.example')),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM editions`);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('Current edition selection', () => {
  it('prefers open, then locked, then the newest; a new draft never displaces them', () => {
    const e = (label: string, status: string) => ({ label, status });
    expect(currentEditionOf([e('2027', 'draft'), e('2026', 'open')])!.label).toBe('2026');
    expect(currentEditionOf([e('2027', 'draft'), e('2026', 'locked')])!.label).toBe('2026');
    expect(currentEditionOf([e('2027', 'draft'), e('2026', 'archived')])!.label).toBe('2027');
    expect(currentEditionOf([e('2026', 'draft')])!.label).toBe('2026');
    expect(currentEditionOf([])).toBeNull();
  });

  it('suggests the next label', () => {
    expect(nextEditionLabel('2026')).toBe('2027');
    expect(nextEditionLabel('Edition 2026 (pilot)')).toBe('Edition 2027 (pilot)');
    expect(nextEditionLabel('Pilot')).toBe('Pilot (next)');
  });
});
