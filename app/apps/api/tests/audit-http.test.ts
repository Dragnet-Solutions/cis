/**
 * D-07 — the Audit screen's API: GET /audit, /audit/facets, /audit.csv.
 *  - setup (edition:manage) or Dragnet (access:dragnet) right only; 403 otherwise
 *  - filters: date range, person, action, item type, edition
 *  - keyset pages of 100, newest first, no overlap
 *  - CSV of the current filter, formula cells defused, capped, and the export
 *    itself audited
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createUser, getPermissionByCode, grantPermissionToUser, initializePool } from '@cis/db';
import { hashPassword } from '@cis/auth';
import { writeAudit } from '@cis/audit';
import { seedReferenceData, auditCsvCell, AUDIT_EXPORT_CAP } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';
const SETUP = 'adaeze.okoro@cis.example';
const PLAIN = 'plain.viewer@cis.example';
const DRAGNET_ONLY = 'dragnet.only@dragnet.example';

let app: FastifyInstance;
let editionId: string;
let makerId: string;
let checkerId: string;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  const pool = getTestPool();
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  makerId = seed.makerUserId;
  checkerId = seed.checkerUserId;
  const hash = await hashPassword(PASSWORD);
  const plain = await createUser(pool, {
    email: PLAIN,
    passwordHash: hash,
    displayName: 'Plain Viewer',
    organization: 'CIS',
  });
  await grantPermissionToUser(
    pool,
    plain.id,
    (await getPermissionByCode(pool, 'access:view'))!.id,
    null,
  );
  const dragnet = await createUser(pool, {
    email: DRAGNET_ONLY,
    passwordHash: hash,
    displayName: 'Dragnet Analyst',
    organization: 'Dragnet',
  });
  await grantPermissionToUser(
    pool,
    dragnet.id,
    (await getPermissionByCode(pool, 'access:dragnet'))!.id,
    null,
  );
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

interface Entry {
  id: string;
  occurredAt: string;
  action: string;
  actor: { id: string; name: string | null; email: string | null } | null;
  entityType: string;
  entityLabel: string | null;
  reason: string | null;
}
async function page(token: string, qs: string) {
  const res = await app.inject({ method: 'GET', url: `/audit?${qs}`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json<{ entries: Entry[]; nextCursor: string | null }>();
}

/** An audit row at a fixed time (direct SQL: writeAudit always stamps now()). */
async function auditAt(at: string, action: string, actorId: string | null): Promise<void> {
  await getTestPool().query(
    `INSERT INTO audit_log (actor_id, action_type, entity_type, entity_id, edition_id, occurred_at)
     VALUES ($1, $2, 'edition', $3, $3, $4)`,
    [actorId, action, editionId, at],
  );
}

describe('D-07 — access', () => {
  it('refuses an operator without the setup or Dragnet right (403), on every route', async () => {
    const t = await tokenFor(PLAIN);
    for (const url of ['/audit', '/audit/facets', '/audit.csv']) {
      const res = await app.inject({ method: 'GET', url, headers: auth(t) });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('admits the setup right and the Dragnet right', async () => {
    for (const email of [SETUP, DRAGNET_ONLY]) {
      const res = await app.inject({
        method: 'GET',
        url: '/audit',
        headers: auth(await tokenFor(email)),
      });
      expect(res.statusCode, email).toBe(200);
    }
  });

  it('has no write routes', async () => {
    const t = await tokenFor(SETUP);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/audit', headers: auth(t), payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });

  it('refuses without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/audit' })).statusCode).toBe(401);
  });
});

describe('D-07 — filters and pages', () => {
  it('filters by date range (whole days, to inclusive), person, action, item type and edition', async () => {
    await auditAt('2026-10-01T09:00:00Z', 'test.alpha', makerId);
    await auditAt('2026-10-02T23:59:00Z', 'test.alpha', checkerId);
    await auditAt('2026-10-03T00:00:01Z', 'test.beta', makerId);
    const t = await tokenFor(SETUP);

    const days = await page(t, 'from=2026-10-01&to=2026-10-02');
    expect(days.entries.map((e) => e.occurredAt)).toEqual([
      '2026-10-02T23:59:00.000Z',
      '2026-10-01T09:00:00.000Z',
    ]);

    const byActor = await page(t, `actorId=${makerId}&from=2026-10-01&to=2026-10-05`);
    expect(byActor.entries.map((e) => e.action)).toEqual(['test.beta', 'test.alpha']);
    expect(byActor.entries[0]!.actor).toEqual({
      id: makerId,
      name: 'Adaeze Okoro',
      email: SETUP,
    });

    const byAction = await page(t, 'action=test.alpha');
    expect(byAction.entries).toHaveLength(2);

    const byEntity = await page(t, `entityType=edition&editionId=${editionId}&action=test.beta`);
    expect(byEntity.entries).toHaveLength(1);
    expect(byEntity.entries[0]!.entityLabel).toBe('2026');

    const facets = await app.inject({ method: 'GET', url: '/audit/facets', headers: auth(t) });
    expect(facets.json().actionTypes).toEqual(expect.arrayContaining(['test.alpha', 'test.beta']));
    expect(facets.json().actors.map((a: { email: string }) => a.email)).toEqual(
      expect.arrayContaining([SETUP]),
    );
  });

  it('pages 100 at a time, newest first, with no overlap and no gap', async () => {
    // 250 rows, several sharing one instant (the id breaks the tie).
    await getTestPool().query(
      `INSERT INTO audit_log (actor_id, action_type, entity_type, occurred_at)
       SELECT $1, 'test.page', 'edition',
              TIMESTAMPTZ '2026-09-01T00:00:00Z' + (g / 3) * INTERVAL '1 minute'
         FROM generate_series(1, 250) g`,
      [makerId],
    );
    const t = await tokenFor(SETUP);
    const seen: Entry[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = await page(t, `action=test.page${cursor ? `&cursor=${cursor}` : ''}`);
      expect(p.entries.length).toBeLessThanOrEqual(100);
      seen.push(...p.entries);
      cursor = p.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(250);
    expect(new Set(seen.map((e) => e.id)).size).toBe(250);
    const times = seen.map((e) => e.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe('D-07 — CSV export', () => {
  it('exports the current filter with formula cells defused, named for the range', async () => {
    const pool = getTestPool();
    for (const reason of ['=HYPERLINK("http://x")', '+1', '-2', '@SUM(A1)', 'plain, "quoted"']) {
      await writeAudit(pool, {
        actorId: makerId,
        actionType: 'test.csv',
        entityType: 'edition',
        entityId: editionId,
        editionId,
        reason,
      });
    }
    await writeAudit(pool, { actorId: makerId, actionType: 'test.other', entityType: 'edition' });
    const t = await tokenFor(SETUP);
    const res = await app.inject({
      method: 'GET',
      url: '/audit.csv?action=test.csv&from=2026-01-01&to=2099-12-31',
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="audit-2026-01-01-2099-12-31.csv"',
    );
    const lines = res.body.trim().split('\r\n');
    expect(lines).toHaveLength(6); // header + five
    expect(res.body).not.toContain('test.other');
    expect(res.body).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(res.body).toContain(`"'+1"`);
    expect(res.body).toContain(`"'-2"`);
    expect(res.body).toContain(`"'@SUM(A1)"`);
    expect(res.body).toContain(`"plain, ""quoted"""`);
    expect(res.body).not.toMatch(/(^|,)"[=+\-@]/m);
  });

  it('audits the export itself, with the filter and the row count', async () => {
    await auditAt('2026-10-01T09:00:00Z', 'test.alpha', makerId);
    await auditAt('2026-10-01T10:00:00Z', 'test.alpha', makerId);
    const t = await tokenFor(SETUP);
    const res = await app.inject({
      method: 'GET',
      url: '/audit.csv?action=test.alpha',
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const logged = await getTestPool().query(
      `SELECT actor_id, new_value FROM audit_log WHERE action_type = 'audit.exported'`,
    );
    expect(logged.rows).toEqual([
      { actor_id: makerId, new_value: { filter: { action: 'test.alpha' }, rows: 2 } },
    ]);
  });

  it(`refuses an export beyond ${AUDIT_EXPORT_CAP} rows with a clear message`, async () => {
    await getTestPool().query(
      `INSERT INTO audit_log (action_type, entity_type)
       SELECT 'test.bulk', 'edition' FROM generate_series(1, $1::int)`,
      [AUDIT_EXPORT_CAP + 1],
    );
    const t = await tokenFor(SETUP);
    const res = await app.inject({
      method: 'GET',
      url: '/audit.csv?action=test.bulk',
      headers: auth(t),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/more than 50,000.*Narrow/);
    const logged = await getTestPool().query(
      `SELECT 1 FROM audit_log WHERE action_type = 'audit.exported'`,
    );
    expect(logged.rowCount).toBe(0);
  });

  it('auditCsvCell quotes every cell and defuses formula prefixes', () => {
    expect(auditCsvCell('=1+1')).toBe(`"'=1+1"`);
    expect(auditCsvCell('\tcmd')).toBe(`"'\tcmd"`);
    expect(auditCsvCell('safe')).toBe('"safe"');
    expect(auditCsvCell(null)).toBe('""');
  });
});
