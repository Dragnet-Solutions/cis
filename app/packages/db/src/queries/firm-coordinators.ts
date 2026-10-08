import { Pool } from 'pg';
import type { FirmCoordinator } from '@cis/shared-types';
import { query } from '../client';

interface RawCoordinatorRow {
  id: string;
  organization_id: string;
  name: string;
  role: string | null;
  email: string;
  phone: string | null;
  is_lead: boolean;
  pin_hash: string | null;
  access_code: string;
  revoked_at: Date | null;
  created_at: Date;
}

function mapCoordinator(row: RawCoordinatorRow): FirmCoordinator {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    role: row.role,
    email: row.email,
    phone: row.phone,
    isLead: row.is_lead,
    accessCode: row.access_code,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export async function createCoordinator(
  pool: Pool,
  data: {
    organizationId: string;
    name: string;
    role?: string | null;
    email: string;
    phone?: string | null;
    isLead?: boolean;
    pinHash?: string | null;
    accessCode: string;
  },
): Promise<FirmCoordinator> {
  const result = await query<RawCoordinatorRow>(
    pool,
    `INSERT INTO firm_coordinators
       (organization_id, name, role, email, phone, is_lead, pin_hash, access_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.organizationId,
      data.name,
      data.role ?? null,
      data.email,
      data.phone ?? null,
      data.isLead ?? false,
      data.pinHash ?? null,
      data.accessCode,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Coordinator insert returned no rows');
  return mapCoordinator(row);
}

/** An active (non-revoked) coordinator identified by their access code — the
 *  interim addressable-party check for firm-facing surfaces. */
export async function getCoordinatorByAccessCode(
  pool: Pool,
  accessCode: string,
): Promise<FirmCoordinator | null> {
  const result = await query<RawCoordinatorRow>(
    pool,
    'SELECT * FROM firm_coordinators WHERE access_code = $1 AND revoked_at IS NULL',
    [accessCode],
  );
  const row = result.rows[0];
  return row ? mapCoordinator(row) : null;
}

export async function getCoordinatorById(pool: Pool, id: string): Promise<FirmCoordinator | null> {
  const result = await query<RawCoordinatorRow>(
    pool,
    'SELECT * FROM firm_coordinators WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  return row ? mapCoordinator(row) : null;
}

/**
 * Every active (non-revoked) coordinator identified by email — the sign-in
 * lookup. Case-insensitive: email addresses are not case-sensitive.
 *
 * Plural, not a single row: `uniq_active_coordinator_email` is unique PER
 * ORGANIZATION, not globally, so the same email can genuinely be an active
 * coordinator at more than one firm (e.g. a consultant coordinating for
 * several client firms). A caller that assumed a single match here would
 * silently sign the wrong firm's coordinator in whenever two firms happen to
 * share an email on file — `coordinatorLogin` verifies the PIN against every
 * candidate this returns, not just the first.
 */
export async function getActiveCoordinatorsByEmail(
  pool: Pool,
  email: string,
): Promise<FirmCoordinator[]> {
  const result = await query<RawCoordinatorRow>(
    pool,
    'SELECT * FROM firm_coordinators WHERE lower(email) = lower($1) AND revoked_at IS NULL',
    [email],
  );
  return result.rows.map(mapCoordinator);
}

/** The stored PIN hash for a coordinator (for current-PIN verification). */
export async function getCoordinatorPinHash(pool: Pool, id: string): Promise<string | null> {
  const result = await query<{ pin_hash: string | null }>(
    pool,
    'SELECT pin_hash FROM firm_coordinators WHERE id = $1',
    [id],
  );
  return result.rows[0]?.pin_hash ?? null;
}

export async function listActiveCoordinators(
  pool: Pool,
  organizationId: string,
): Promise<FirmCoordinator[]> {
  const result = await query<RawCoordinatorRow>(
    pool,
    `SELECT * FROM firm_coordinators
      WHERE organization_id = $1 AND revoked_at IS NULL
      ORDER BY is_lead DESC, created_at`,
    [organizationId],
  );
  return result.rows.map(mapCoordinator);
}

export async function getActiveLead(
  pool: Pool,
  organizationId: string,
): Promise<FirmCoordinator | null> {
  const result = await query<RawCoordinatorRow>(
    pool,
    `SELECT * FROM firm_coordinators
      WHERE organization_id = $1 AND is_lead = TRUE AND revoked_at IS NULL`,
    [organizationId],
  );
  const row = result.rows[0];
  return row ? mapCoordinator(row) : null;
}

export async function setCoordinatorPinHash(
  pool: Pool,
  id: string,
  pinHash: string,
): Promise<void> {
  await query(pool, 'UPDATE firm_coordinators SET pin_hash = $2 WHERE id = $1', [id, pinHash]);
}

export async function setCoordinatorLead(pool: Pool, id: string, isLead: boolean): Promise<void> {
  await query(pool, 'UPDATE firm_coordinators SET is_lead = $2 WHERE id = $1', [id, isLead]);
}

/** Immediate revocation. A re-add later issues a NEW row with a new access code. */
export async function revokeCoordinator(pool: Pool, id: string): Promise<void> {
  await query(
    pool,
    'UPDATE firm_coordinators SET revoked_at = NOW(), is_lead = FALSE WHERE id = $1',
    [id],
  );
}
