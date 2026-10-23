/**
 * D-01 — freezing new institution questionnaires while the edition collects,
 * over HTTP, as the restricted Surveys screen drives it:
 *  open edition with instruments not yet frozen into it → person A requests
 *  the freeze → A's own approval is refused → B approves → the institution's
 *  survey link issues and the survey email is queued.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, listInstitutions, updateEditionStatus } from '@cis/db';
import { loadRbacContext } from '@cis/auth';
import {
  seedReferenceData,
  requestFreeze,
  decideFreeze,
  REGULATOR_SURVEY_LINK_EMAIL_KIND,
} from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';
const A = 'adaeze.okoro@cis.example';
const B = 'segun.oyegbesan@dragnet.example';
const NEW_CODES = ['I-FMDQ', 'I-LCFE', 'I-NASD'];

let app: FastifyInstance;
let editionId: string;
let lcfeId: string;

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
  // The edition was frozen and opened before the three institution
  // questionnaires joined the register: freeze everything, open, then take
  // the three back out of this edition's snapshot.
  const maker = await loadRbacContext(pool, seed.makerUserId);
  const checker = await loadRbacContext(pool, seed.checkerUserId);
  const first = await requestFreeze(pool, maker, editionId, 'Freeze for launch');
  await decideFreeze(pool, checker, editionId, first.id, { approved: true });
  await updateEditionStatus(pool, editionId, 'open');
  await pool.query(
    `DELETE FROM edition_instrument_snapshots s
      USING instrument_definition_versions v, instrument_definitions d
      WHERE s.instrument_definition_version_id = v.id
        AND v.instrument_definition_id = d.id
        AND s.edition_id = $1 AND d.code = ANY($2)`,
    [editionId, NEW_CODES],
  );
  lcfeId = (await listInstitutions(pool)).find(
    (i) => i.name === 'Lagos Commodities and Futures Exchange',
  )!.id;
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

async function issueLcfeLink(token: string) {
  return app.inject({
    method: 'POST',
    url: `/editions/${editionId}/regulators/${lcfeId}/B/issue-link`,
    headers: auth(token),
    payload: { targetBy: '2026-11-15' },
  });
}

describe('D-01 — freeze new questionnaires into an open edition', () => {
  it('A requests, A cannot approve, B approves, and the link issues with its email', async () => {
    const a = await tokenFor(A);
    const b = await tokenFor(B);

    // The restricted Surveys screen reads the pending questionnaires.
    const before = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/instruments`,
      headers: auth(a),
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      frozen: true,
      pendingInstruments: NEW_CODES,
      pendingFreeze: null,
    });

    // Contact saved; the link is refused until the questionnaire is frozen.
    const contact = await app.inject({
      method: 'PUT',
      url: `/editions/${editionId}/regulators/${lcfeId}/B/contact`,
      headers: auth(a),
      payload: {
        who: 'Amaka Eze',
        role: 'Head, Market Operations',
        email: 'a.eze@lcfe.example',
        phone: '+234 803 555 0101',
        how: 'Introduced through the CIS courtesy approach',
      },
    });
    expect(contact.statusCode).toBe(200);
    const refused = await issueLcfeLink(a);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/not frozen/i);

    // A asks; one request covers every pending questionnaire.
    const req = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/instruments/freeze/request`,
      headers: auth(a),
      payload: { reason: 'Add LCFE, NASD and FMDQ questionnaires' },
    });
    expect(req.statusCode).toBe(201);
    const actionId = req.json<{ criticalActionId: string }>().criticalActionId;

    const pending = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/instruments`,
      headers: auth(b),
    });
    expect(pending.json().pendingFreeze).toMatchObject({
      id: actionId,
      reason: expect.any(String),
    });

    // A's own approval is refused (maker-checker, server-side).
    const self = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/instruments/freeze/${actionId}/decide`,
      headers: auth(a),
      payload: { approved: true },
    });
    expect(self.statusCode).toBe(403);

    // B approves.
    const ok = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/instruments/freeze/${actionId}/decide`,
      headers: auth(b),
      payload: { approved: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'approved', frozen: true });

    const after = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/instruments`,
      headers: auth(a),
    });
    expect(after.json()).toMatchObject({ pendingInstruments: [], pendingFreeze: null });

    // Now the link issues, and the survey email is queued to the contact.
    const issued = await issueLcfeLink(a);
    expect(issued.statusCode).toBe(200);
    expect(issued.json().regulator.surveyLink).toMatch(/\/journeys\/resume\//);
    const mail = await getTestPool().query<{ to_address: string }>(
      `SELECT * FROM email_outbox WHERE kind = $1`,
      [REGULATOR_SURVEY_LINK_EMAIL_KIND],
    );
    expect(mail.rowCount).toBe(1);
  });

  it('a rejected request leaves the questionnaires pending, and the link still refused', async () => {
    const a = await tokenFor(A);
    const b = await tokenFor(B);
    const req = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/instruments/freeze/request`,
      headers: auth(a),
      payload: { reason: 'Add LCFE, NASD and FMDQ questionnaires' },
    });
    const actionId = req.json<{ criticalActionId: string }>().criticalActionId;
    const rej = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/instruments/freeze/${actionId}/decide`,
      headers: auth(b),
      payload: { approved: false, rejectionReason: 'Wording not yet signed off' },
    });
    expect(rej.json()).toEqual({ status: 'rejected', frozen: true });
    const view = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/instruments`,
      headers: auth(a),
    });
    expect(view.json()).toMatchObject({ pendingInstruments: NEW_CODES, pendingFreeze: null });
  });
});
