/**
 * Instrument-freeze integration tests (real Postgres). Covers:
 *  - freeze goes through maker-checker; on approval every instrument is
 *    snapshotted immutably and the edition's set is frozen
 *  - self-approve/self-reject rejected at the service layer
 *  - the DB CHECK constraint rejects self-approval even via direct SQL
 *  - freeze only in draft, and not twice
 *  - request/approve require the right permissions
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  getEditionInstrumentSnapshots,
  isEditionInstrumentSetFrozen,
  updateEditionStatus,
  createUser,
  createCriticalAction,
  INSTRUMENT_CODES,
} from '@cis/db';
import { loadRbacContext, MakerCheckerViolationError, PermissionDeniedError } from '@cis/auth';
import { seedReferenceData, requestFreeze, decideFreeze, EditionStateError } from '../src';
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

async function seedAndContexts() {
  const seed = await seedReferenceData(pool);
  const maker = await loadRbacContext(pool, seed.makerUserId);
  const checker = await loadRbacContext(pool, seed.checkerUserId);
  return { seed, maker, checker };
}

describe('Instrument freeze (maker-checker)', () => {
  it('snapshots every instrument and marks the set frozen on approval', async () => {
    const { seed, maker, checker } = await seedAndContexts();
    expect(await isEditionInstrumentSetFrozen(pool, seed.editionId)).toBe(false);

    const action = await requestFreeze(pool, maker, seed.editionId, 'Wording confirmed with CIS');
    expect(action.status).toBe('pending');

    const { frozen } = await decideFreeze(pool, checker, seed.editionId, action.id, {
      approved: true,
    });
    expect(frozen).toBe(true);

    const snapshots = await getEditionInstrumentSnapshots(pool, seed.editionId);
    expect(snapshots).toHaveLength(INSTRUMENT_CODES.length);
    expect(await isEditionInstrumentSetFrozen(pool, seed.editionId)).toBe(true);

    // Audit: the freeze decision is recorded.
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM audit_log
       WHERE entity_type='edition' AND entity_id=$1 AND action_type='instruments.frozen'`,
      [seed.editionId],
    );
    expect(parseInt(r.rows[0]?.c ?? '0', 10)).toBe(1);
  });

  it('rejects a self-approval by the requester at the service layer', async () => {
    const { seed, maker } = await seedAndContexts();
    const action = await requestFreeze(pool, maker, seed.editionId, 'Wording confirmed');
    await expect(
      decideFreeze(pool, maker, seed.editionId, action.id, { approved: true }),
    ).rejects.toBeInstanceOf(MakerCheckerViolationError);
    expect(await isEditionInstrumentSetFrozen(pool, seed.editionId)).toBe(false);
  });

  it('rejects a self-rejection by the requester at the service layer', async () => {
    const { seed, maker } = await seedAndContexts();
    const action = await requestFreeze(pool, maker, seed.editionId, 'Wording confirmed');
    await expect(
      decideFreeze(pool, maker, seed.editionId, action.id, { approved: false }),
    ).rejects.toBeInstanceOf(MakerCheckerViolationError);
  });

  it('is enforced by the DB CHECK even on direct SQL (scoped to instrument_freeze)', async () => {
    const { seed } = await seedAndContexts();
    const action = await createCriticalAction(pool, {
      actionType: 'instrument_freeze',
      requestedBy: seed.makerUserId,
      payload: { reason: 'direct' },
      editionId: seed.editionId,
    });
    await expect(
      pool.query(
        `UPDATE critical_actions SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2`,
        [seed.makerUserId, action.id],
      ),
    ).rejects.toThrow(/maker_checker_no_self_approval/);
  });

  it('cannot be requested once already frozen', async () => {
    const { seed, maker, checker } = await seedAndContexts();
    const action = await requestFreeze(pool, maker, seed.editionId, 'Wording confirmed');
    await decideFreeze(pool, checker, seed.editionId, action.id, { approved: true });

    await expect(
      requestFreeze(pool, maker, seed.editionId, 'Freeze again please'),
    ).rejects.toBeInstanceOf(EditionStateError);
  });

  it('cannot be requested outside draft', async () => {
    const { seed, maker } = await seedAndContexts();
    await updateEditionStatus(pool, seed.editionId, 'open');
    await expect(
      requestFreeze(pool, maker, seed.editionId, 'Wording confirmed'),
    ).rejects.toBeInstanceOf(EditionStateError);
  });

  it('requires request permission', async () => {
    const { seed } = await seedAndContexts();
    const stranger = await createUser(pool, {
      email: 'stranger2@nowhere.example',
      passwordHash: '$argon2id$test',
      displayName: 'Stranger',
    });
    const strangerRbac = await loadRbacContext(pool, stranger.id);
    await expect(
      requestFreeze(pool, strangerRbac, seed.editionId, 'Trying to freeze'),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
