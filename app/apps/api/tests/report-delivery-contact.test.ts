/**
 * QA E14 over real HTTP: a report-delivery choice is only kept when it can be
 * delivered — email needs an address, text a mobile number (given now or
 * already on file); "no report" needs nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool, createRespondent, getRespondentById } from '@cis/db';
import { seedReferenceData } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

let app: FastifyInstance;
let respondentId: string;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  const { editionId } = await seedReferenceData(getPool());
  respondentId = (await createRespondent(getPool(), { editionId, instrumentCode: 'S4' })).id;
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

const change = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/journeys/${respondentId}/report-delivery`, payload });

describe('report delivery needs a way to deliver (QA E14)', () => {
  it('refuses email with no address, or a bad one, and changes nothing', async () => {
    expect((await change({ reportDelivery: 'email' })).statusCode).toBe(400);
    expect((await change({ reportDelivery: 'email', email: 'nope' })).statusCode).toBe(400);
    expect((await getRespondentById(getPool(), respondentId))!.reportDelivery).not.toBe('email');
  });

  it('refuses text with no mobile number', async () => {
    expect((await change({ reportDelivery: 'text', email: 'ada@example.com' })).statusCode).toBe(
      400,
    );
  });

  it('refuses a channel that does not exist', async () => {
    expect((await change({ reportDelivery: 'pigeon' })).statusCode).toBe(400);
  });

  it('keeps a deliverable choice, and an address already on file counts', async () => {
    const ok = await change({ reportDelivery: 'email', email: ' ada@example.com ' });
    expect(ok.statusCode).toBe(200);
    const saved = (await getRespondentById(getPool(), respondentId))!;
    expect(saved.reportDelivery).toBe('email');
    expect(saved.contactEmail).toBe('ada@example.com');
    // Switching away and back needs no address again: one is on file.
    expect((await change({ reportDelivery: 'none' })).statusCode).toBe(200);
    expect((await change({ reportDelivery: 'email' })).statusCode).toBe(200);
  });
});
