/**
 * Maker-checker emails: a request asks every approver except the requester to
 * decide (O-03); the decision is told to the requester (O-04).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { getUserById, listCriticalActionApprovers } from '@cis/db';
import { loadRbacContext } from '@cis/auth';
import {
  seedReferenceData,
  requestFreeze,
  decideFreeze,
  APPROVAL_REQUESTED_EMAIL_KIND,
  APPROVAL_OUTCOME_EMAIL_KIND,
} from '../src';
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

interface Row {
  kind: string;
  ref_id: string;
  to_address: string;
  subject: string;
  body_text: string;
  body_html: string;
}
const outbox = async (kind: string) =>
  (
    await pool.query<Row>(
      'SELECT kind, ref_id, to_address, subject, body_text, body_html FROM email_outbox WHERE kind = $1 ORDER BY to_address',
      [kind],
    )
  ).rows;

describe('Approval requested (O-03) and outcome (O-04)', () => {
  it('asks every approver except the requester, then tells the requester the decision', async () => {
    const seed = await seedReferenceData(pool);
    const maker = await loadRbacContext(pool, seed.makerUserId);
    const checker = await loadRbacContext(pool, seed.checkerUserId);
    const makerUser = (await getUserById(pool, seed.makerUserId))!;
    const checkerUser = (await getUserById(pool, seed.checkerUserId))!;

    const action = await requestFreeze(pool, maker, seed.editionId, 'Pilot complete');
    const asked = await outbox(APPROVAL_REQUESTED_EMAIL_KIND);
    const approvers = await listCriticalActionApprovers(pool, 'instrument_freeze', null);
    const expected = approvers
      .filter((a) => a.id !== seed.makerUserId)
      .map((a) => a.email)
      .sort();
    expect(asked.map((r) => r.to_address)).toEqual(expected);
    expect(expected).toContain(checkerUser.email);
    expect(asked.map((r) => r.to_address)).not.toContain(makerUser.email);
    for (const r of asked) {
      expect(r.ref_id).toBe(action.id);
      expect(r.subject).toBe('Approval needed: Freeze the survey instruments');
      expect(r.body_text).toContain(`${makerUser.displayName} needs your approval`);
      expect(r.body_text).toMatch(/Review and decide:\nhttp\S+\/\?tab=surveys/);
      expect(r.body_html).toContain('/cis-logo.png');
    }
    expect(await outbox(APPROVAL_OUTCOME_EMAIL_KIND)).toHaveLength(0);

    await decideFreeze(pool, checker, seed.editionId, action.id, {
      approved: false,
      rejectionReason: 'Wording of S2 still under review',
    });
    const told = await outbox(APPROVAL_OUTCOME_EMAIL_KIND);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ ref_id: action.id, to_address: makerUser.email });
    expect(told[0]!.subject).toBe('Freeze the survey instruments: Declined');
    expect(told[0]!.body_text).toContain('Your request was declined');
    expect(told[0]!.body_text).toContain(`${checkerUser.displayName} has decided on your request.`);
    expect(told[0]!.body_text).toContain('Reason: Wording of S2 still under review');

    // An approval is told the same way.
    const again = await requestFreeze(pool, maker, seed.editionId, 'Wording now settled');
    await decideFreeze(pool, checker, seed.editionId, again.id, { approved: true });
    const approved = (await outbox(APPROVAL_OUTCOME_EMAIL_KIND)).filter(
      (r) => r.ref_id === again.id,
    );
    expect(approved).toHaveLength(1);
    expect(approved[0]!.subject).toBe('Freeze the survey instruments: Approved');
    expect(approved[0]!.to_address).toBe(makerUser.email);
  });
});
