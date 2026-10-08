/**
 * Post-demo findings (§2) — HTTP-layer integration test for the edition
 * date-save flow (opening/closing date) and the instrument-freeze
 * request/approve flow, hitting the real Fastify app (via `app.inject`,
 * no listening socket needed) against a real Postgres database.
 *
 * A fresh-environment live reproduction of this exact path (login, save each
 * date, reload, request freeze as one user, approve as a different user,
 * confirm the frozen state) found no bug — both flows persist correctly and
 * the reported issue was traced to a stale demo environment, not the code.
 * This test closes the coverage gap the reproduction surfaced: unlike the
 * domain layer (edition-service.test.ts, instrument-freeze.test.ts), nothing
 * previously exercised these routes over real HTTP with a real JWT, so a
 * future regression in request parsing, auth wiring, or response
 * serialization here would not have been caught by any existing test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool } from '@cis/db';
import { seedReferenceData } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';

let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

describe('Edition date-save flow, over real HTTP (§2)', () => {
  it('saves the planned launch date and the closing date, and both persist on a fresh GET', async () => {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const auth = { authorization: `Bearer ${token}` };

    const openRes = await app.inject({
      method: 'PATCH',
      url: `/editions/${seed.editionId}/opening-date`,
      headers: auth,
      payload: { openDate: '2026-10-16' },
    });
    expect(openRes.statusCode).toBe(200);
    expect(openRes.json<{ plannedOpenAt: string | null }>().plannedOpenAt).toMatch(/^2026-10-16/);

    const closeRes = await app.inject({
      method: 'PATCH',
      url: `/editions/${seed.editionId}/closing-date`,
      headers: auth,
      payload: { closingDate: '2026-11-21' },
    });
    expect(closeRes.statusCode).toBe(200);
    expect(closeRes.json<{ surveyCloseAt: string | null }>().surveyCloseAt).toMatch(/^2026-11-21/);

    // The save-then-reload path: a fresh GET (a different request, same as a
    // browser reload) must reflect both saved values, not just the PATCH echo.
    const reloadRes = await app.inject({
      method: 'GET',
      url: `/editions/${seed.editionId}`,
      headers: auth,
    });
    expect(reloadRes.statusCode).toBe(200);
    const reloaded = reloadRes.json<{
      plannedOpenAt: string | null;
      surveyCloseAt: string | null;
    }>();
    expect(reloaded.plannedOpenAt).toMatch(/^2026-10-16/);
    expect(reloaded.surveyCloseAt).toMatch(/^2026-11-21/);

    // The underlying row itself, independent of what the API chooses to echo.
    const row = await getPool().query<{ planned_open_at: Date; survey_close_at: Date }>(
      `SELECT planned_open_at, survey_close_at FROM editions WHERE id = $1`,
      [seed.editionId],
    );
    expect(row.rows[0]?.planned_open_at.toISOString()).toMatch(/^2026-10-16/);
    expect(row.rows[0]?.survey_close_at.toISOString()).toMatch(/^2026-11-21/);
  });
});

describe('Instrument freeze request/approve flow, over real HTTP (§2)', () => {
  it('a freeze requested by one user and approved by a different user actually freezes every instrument', async () => {
    const seed = await seedReferenceData(getPool());
    const makerToken = await login('adaeze.okoro@cis.example');

    const beforeRes = await app.inject({
      method: 'GET',
      url: `/editions/${seed.editionId}/instruments`,
      headers: { authorization: `Bearer ${makerToken}` },
    });
    expect(beforeRes.statusCode).toBe(200);
    expect(beforeRes.json<{ frozen: boolean }>().frozen).toBe(false);

    const requestRes = await app.inject({
      method: 'POST',
      url: `/editions/${seed.editionId}/instruments/freeze/request`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: { reason: 'Pilot complete, wording confirmed' },
    });
    expect(requestRes.statusCode).toBe(201);
    const { criticalActionId } = requestRes.json<{ criticalActionId: string }>();

    // A second, different user approves — maker-checker enforced.
    const checkerToken = await login('segun.oyegbesan@dragnet.example');
    const decideRes = await app.inject({
      method: 'POST',
      url: `/editions/${seed.editionId}/instruments/freeze/${criticalActionId}/decide`,
      headers: { authorization: `Bearer ${checkerToken}` },
      payload: { approved: true },
    });
    expect(decideRes.statusCode).toBe(200);
    expect(decideRes.json<{ status: string; frozen: boolean }>()).toEqual({
      status: 'approved',
      frozen: true,
    });

    // A fresh GET, as either user, reflects the frozen state.
    const afterRes = await app.inject({
      method: 'GET',
      url: `/editions/${seed.editionId}/instruments`,
      headers: { authorization: `Bearer ${makerToken}` },
    });
    expect(afterRes.json<{ frozen: boolean }>().frozen).toBe(true);

    // The underlying rows: every instrument version frozen, and the
    // maker-checker record shows two different users.
    const versions = await getPool().query<{ is_frozen: boolean }>(
      `SELECT is_frozen FROM instrument_definition_versions`,
    );
    expect(versions.rows.length).toBeGreaterThan(0);
    expect(versions.rows.every((r) => r.is_frozen)).toBe(true);

    const action = await getPool().query<{
      requested_by: string;
      approved_by: string | null;
      status: string;
    }>(`SELECT requested_by, approved_by, status FROM critical_actions WHERE id = $1`, [
      criticalActionId,
    ]);
    expect(action.rows[0]?.status).toBe('approved');
    expect(action.rows[0]?.approved_by).not.toBe(action.rows[0]?.requested_by);
  });
});
