/**
 * InvitationsPage live-wiring fix (UX-OPS-002) — HTTP-layer tests for the two
 * new routes added while wiring the admin page to its real backend:
 *
 *  - POST /editions/:id/invitations/resolve-firm-names — closes a real gap:
 *    `resolveFirmNameToOrg` existed in invitations-service.ts and was never
 *    called from anywhere, so an uploaded CSV row had no way to carry a real
 *    organizationId into validation/send, and the fourth file-validation
 *    check (already sent this template) could never fire for an upload.
 *  - GET /invitations/batches/:batchId/bounced — the domain layer already
 *    had `listBouncedRecipients` (its own doc comment says "for the 'list the
 *    addresses that bounced' action"), tested at the DB layer, but no route
 *    or domain wrapper ever exposed it.
 *
 * Everything else this page calls (audiences, templates, validate-upload,
 * send, batches, batch report, requests, resolve) already had routes and
 * HTTP-level behaviour identical to what packages/domain/tests/invitations.test.ts
 * already covers at the domain layer — only these two needed new coverage.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  createOrganization,
  createBatch,
  insertRecipient,
  recordDelivery,
} from '@cis/db';
import { seedReferenceData, addPerson } from '@cis/domain';
import { hashPassword } from '@cis/auth';
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

describe('POST /editions/:id/invitations/resolve-firm-names', () => {
  it('resolves a real firm name and leaves an unmatched one null, in one call', async () => {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const org = await createOrganization(getPool(), {
      slug: 'http-test-firm',
      displayName: 'HTTP Test Firm Ltd',
      orgType: 'firm',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/editions/${seed.editionId}/invitations/resolve-firm-names`,
      headers: { authorization: `Bearer ${token}` },
      payload: { firmNames: ['HTTP TEST FIRM LTD', 'Nobody Ltd'] },
    });
    expect(res.statusCode).toBe(200);
    const { resolved } = res.json<{ resolved: Record<string, string | null> }>();
    expect(resolved['HTTP TEST FIRM LTD']).toBe(org.id);
    expect(resolved['Nobody Ltd']).toBeNull();
  });
});

describe('GET /invitations/batches/:batchId/bounced', () => {
  it('lists only the bounced recipients for the batch, over real HTTP', async () => {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const templates = await app
      .inject({
        method: 'GET',
        url: `/editions/${seed.editionId}/invitations/templates`,
        headers: { authorization: `Bearer ${token}` },
      })
      .then((r) => r.json<{ templates: Array<{ id: string; name: string }> }>().templates);
    const template = templates.find((t) => t.name === 'First invitation');
    expect(template).toBeTruthy();

    const batch = await createBatch(getPool(), {
      editionId: seed.editionId,
      templateId: template!.id,
      audienceId: 'upload',
      audienceLabel: 'Uploaded list',
    });
    const ok = await insertRecipient(getPool(), {
      batchId: batch.id,
      editionId: seed.editionId,
      recipientEmail: 'ok@x.example',
    });
    const bad = await insertRecipient(getPool(), {
      batchId: batch.id,
      editionId: seed.editionId,
      recipientEmail: 'bad@x.example',
    });
    await recordDelivery(getPool(), ok.id, { deliveryState: 'delivered' });
    await recordDelivery(getPool(), bad.id, { deliveryState: 'bounced' });

    const res = await app.inject({
      method: 'GET',
      url: `/invitations/batches/${batch.id}/bounced`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { bounced } = res.json<{ bounced: Array<{ recipientEmail: string | null }> }>();
    expect(bounced.map((r) => r.recipientEmail)).toEqual(['bad@x.example']);
  });
});

describe('POST /editions/:id/invitations/send needs the right to write to people', () => {
  it('refuses an operator without "access:send", sending nothing', async () => {
    const seed = await seedReferenceData(getPool());
    const plain = await addPerson(getPool(), {
      name: 'Plain',
      email: 'plain@cis.example',
      organization: 'CIS',
      rights: {},
      actorId: seed.makerUserId,
    });
    await getPool().query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await hashPassword(PASSWORD),
      plain.userId,
    ]);
    const templates = await getPool().query<{ id: string }>(
      'SELECT id FROM message_templates WHERE edition_id = $1 LIMIT 1',
      [seed.editionId],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/editions/${seed.editionId}/invitations/send`,
      headers: { authorization: `Bearer ${await login('plain@cis.example')}` },
      payload: { templateId: templates.rows[0]!.id, audienceId: 'all' },
    });
    expect(res.statusCode).toBe(403);
    const batches = await getPool().query('SELECT 1 FROM message_batches');
    expect(batches.rowCount).toBe(0);
  });
});
