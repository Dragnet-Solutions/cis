/**
 * Shared test helpers for claiming a firm's space. A claim needs the firm's
 * invitation link, so tests that only care about what happens after the claim
 * open an invitation first, exactly as an operator would.
 */
import type { Pool } from 'pg';
import { createFirmInvitation } from '@cis/db';
import { claimSpace, type ClaimInput } from '../../src';

/** Opens a pending invitation for the firm and returns its link's token. */
export async function openInvitationToken(
  pool: Pool,
  organizationId: string,
  email = 'invited@firm.example',
): Promise<string> {
  const user = await pool.query<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1');
  const invitedBy = user.rows[0]?.id;
  if (!invitedBy) throw new Error('openInvitationToken needs a user (seed reference data first)');
  const inv = await createFirmInvitation(pool, {
    organizationId,
    email,
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    invitedBy,
  });
  return inv.token;
}

/** claimSpace with a fresh invitation for the firm. */
export async function claimWithInvitation(
  pool: Pool,
  input: Omit<ClaimInput, 'inviteToken'>,
  notify: { portalUrl?: string | null } = {},
): ReturnType<typeof claimSpace> {
  const inviteToken = await openInvitationToken(pool, input.organizationId);
  return claimSpace(pool, { ...input, inviteToken }, notify);
}
