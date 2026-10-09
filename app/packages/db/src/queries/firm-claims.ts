import { Pool } from 'pg';
import type { FirmClaim } from '@cis/shared-types';
import { query } from '../client';

interface RawClaimRow {
  id: string;
  organization_id: string;
  claimed_at: Date;
  claiming_contact_name: string;
  claiming_contact_email: string;
  lead_coordinator_id: string | null;
  privacy_consent: boolean;
  follow_up_consent: boolean;
  created_at: Date;
}

function mapClaim(row: RawClaimRow): FirmClaim {
  return {
    id: row.id,
    organizationId: row.organization_id,
    claimedAt: row.claimed_at,
    claimingContactName: row.claiming_contact_name,
    claimingContactEmail: row.claiming_contact_email,
    leadCoordinatorId: row.lead_coordinator_id,
    privacyConsent: row.privacy_consent,
    followUpConsent: row.follow_up_consent,
    createdAt: row.created_at,
  };
}

export async function getFirmClaim(pool: Pool, organizationId: string): Promise<FirmClaim | null> {
  const result = await query<RawClaimRow>(
    pool,
    'SELECT * FROM firm_claims WHERE organization_id = $1',
    [organizationId],
  );
  const row = result.rows[0];
  return row ? mapClaim(row) : null;
}

/**
 * Create the firm's claim. The UNIQUE(organization_id) constraint makes "one
 * firm, one space" a database invariant; the domain layer catches the conflict
 * and redirects the second claimant WITHOUT disclosing who claimed first.
 */
export async function insertFirmClaim(
  pool: Pool,
  data: {
    organizationId: string;
    claimingContactName: string;
    claimingContactEmail: string;
    leadCoordinatorId?: string | null;
    privacyConsent: boolean;
    followUpConsent: boolean;
  },
): Promise<FirmClaim> {
  const result = await query<RawClaimRow>(
    pool,
    `INSERT INTO firm_claims
       (organization_id, claiming_contact_name, claiming_contact_email,
        lead_coordinator_id, privacy_consent, follow_up_consent)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.organizationId,
      data.claimingContactName,
      data.claimingContactEmail,
      data.leadCoordinatorId ?? null,
      data.privacyConsent,
      data.followUpConsent,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Firm claim insert returned no rows');
  return mapClaim(row);
}

/** Update the per-firm follow-up consent (UX-ADM-007 filters on it). Gates nothing. */
export async function setFollowUpConsent(
  pool: Pool,
  organizationId: string,
  followUpConsent: boolean,
): Promise<void> {
  await query(pool, 'UPDATE firm_claims SET follow_up_consent = $2 WHERE organization_id = $1', [
    organizationId,
    followUpConsent,
  ]);
}

/** Firms that ticked follow-up consent — the only basis for commercial approach. */
export async function listFollowUpConsentedFirms(pool: Pool): Promise<string[]> {
  const result = await query<{ organization_id: string }>(
    pool,
    'SELECT organization_id FROM firm_claims WHERE follow_up_consent = TRUE ORDER BY organization_id',
  );
  return result.rows.map((r) => r.organization_id);
}

/** Every organization id that has claimed its space (claims are not
 *  edition-scoped — one firm, one space). For invitation audiences. */
export async function listClaimedOrganizationIds(pool: Pool): Promise<string[]> {
  const result = await query<{ organization_id: string }>(
    pool,
    'SELECT organization_id FROM firm_claims',
  );
  return result.rows.map((r) => r.organization_id);
}
