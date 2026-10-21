import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createUser, getMethodologyMeta } from '../src';

/**
 * Test helper: record that two people approved the scoring methodology version
 * in force — the state a run must be made in to be official. Without it the DB
 * stamps every new run TEST_UNAPPROVED (which can never be signed off or reach
 * a report). Call it after truncating, before creating runs that a test signs
 * off or reports from.
 */
export async function approveMethodologyForTests(pool: Pool): Promise<void> {
  const tag = randomUUID().slice(0, 8);
  const maker = await createUser(pool, {
    email: `methodology-maker-${tag}@test.example`,
    passwordHash: 'x',
    displayName: 'Methodology Maker',
    organization: 'CIS',
  });
  const checker = await createUser(pool, {
    email: `methodology-checker-${tag}@test.example`,
    passwordHash: 'x',
    displayName: 'Methodology Checker',
    organization: 'Dragnet',
  });
  const meta = getMethodologyMeta();
  await pool.query(
    `INSERT INTO critical_actions
       (action_type, status, requested_by, approved_by, approved_at, payload)
     VALUES ('scoring_methodology_approval', 'approved', $1, $2, NOW(), $3)`,
    [
      maker.id,
      checker.id,
      JSON.stringify({ methodologyId: meta.id, version: meta.version, reason: 'Test approval' }),
    ],
  );
}
