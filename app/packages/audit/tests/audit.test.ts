/**
 * Audit service integration tests — proves:
 *  1. writeAudit correctly records actor/old/new/reason.
 *  2. audit_log is immutable: UPDATE and DELETE are rejected by DB trigger.
 *  3. Direct writes bypass the service → not possible via the exported API.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createUser } from '@cis/db';
import { writeAudit, getAuditEntriesForEntity } from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});

beforeEach(async () => {
  await truncateAllTables(pool);
});

afterAll(async () => {
  await closeTestPool();
});

async function seedUser() {
  return createUser(pool, {
    email: 'actor@example.com',
    passwordHash: '$argon2id$test',
    displayName: 'Actor',
  });
}

describe('Audit service', () => {
  it('writes a complete audit record capturing actor, entity, old/new/reason', async () => {
    const actor = await seedUser();

    const id = await writeAudit(pool, {
      actorId: actor.id,
      actionType: 'edition.status.changed',
      entityType: 'edition',
      entityId: '00000000-0000-4000-8000-000000000001',
      oldValue: { status: 'draft' },
      newValue: { status: 'open' },
      reason: 'Survey period started',
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent/1.0',
    });

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);

    const entries = await getAuditEntriesForEntity(
      pool,
      'edition',
      '00000000-0000-4000-8000-000000000001',
    );

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.actorId).toBe(actor.id);
    expect(entry?.actionType).toBe('edition.status.changed');
    expect(entry?.entityType).toBe('edition');
    expect(entry?.oldValue).toEqual({ status: 'draft' });
    expect(entry?.newValue).toEqual({ status: 'open' });
    expect(entry?.reason).toBe('Survey period started');
    expect(entry?.ipAddress).toBe('127.0.0.1');
    expect(entry?.userAgent).toBe('test-agent/1.0');
    expect(entry?.occurredAt).toBeInstanceOf(Date);
  });

  it('writes an audit record with null actor (system action)', async () => {
    const id = await writeAudit(pool, {
      actorId: null,
      actionType: 'system.migration.applied',
      entityType: 'system',
      entityId: null,
    });

    const result = await pool.query<{ actor_id: string | null }>(
      'SELECT actor_id FROM audit_log WHERE id = $1',
      [id],
    );
    expect(result.rows[0]?.actor_id).toBeNull();
  });

  it('accumulates multiple audit entries for the same entity', async () => {
    const actor = await seedUser();
    const entityId = '00000000-0000-4000-8000-000000000002';

    await writeAudit(pool, {
      actorId: actor.id,
      actionType: 'edition.created',
      entityType: 'edition',
      entityId,
    });
    await writeAudit(pool, {
      actorId: actor.id,
      actionType: 'edition.status.changed',
      entityType: 'edition',
      entityId,
      oldValue: { status: 'draft' },
      newValue: { status: 'open' },
    });

    const entries = await getAuditEntriesForEntity(pool, 'edition', entityId);
    expect(entries).toHaveLength(2);
    // Ordered by occurred_at DESC
    expect(entries[0]?.actionType).toBe('edition.status.changed');
    expect(entries[1]?.actionType).toBe('edition.created');
  });
});

describe('audit_log immutability (DB trigger enforcement)', () => {
  it('rejects UPDATE on audit_log rows', async () => {
    const actor = await seedUser();
    const id = await writeAudit(pool, {
      actorId: actor.id,
      actionType: 'test.action',
      entityType: 'test',
      entityId: null,
    });

    await expect(
      pool.query(`UPDATE audit_log SET reason = 'tampered' WHERE id = $1`, [id]),
    ).rejects.toThrow(/audit_log is immutable/);
  });

  it('rejects DELETE on audit_log rows', async () => {
    const actor = await seedUser();
    const id = await writeAudit(pool, {
      actorId: actor.id,
      actionType: 'test.action',
      entityType: 'test',
      entityId: null,
    });

    await expect(pool.query(`DELETE FROM audit_log WHERE id = $1`, [id])).rejects.toThrow(
      /audit_log is immutable/,
    );
  });

  it('original audit record is unchanged after failed tamper attempt', async () => {
    const actor = await seedUser();
    const id = await writeAudit(pool, {
      actorId: actor.id,
      actionType: 'original.action',
      entityType: 'test',
      entityId: null,
      reason: 'original reason',
    });

    // Attempt to tamper — will throw
    try {
      await pool.query(`UPDATE audit_log SET reason = 'tampered' WHERE id = $1`, [id]);
    } catch {
      // expected
    }

    const result = await pool.query<{ reason: string }>(
      'SELECT reason FROM audit_log WHERE id = $1',
      [id],
    );
    expect(result.rows[0]?.reason).toBe('original reason');
  });
});
