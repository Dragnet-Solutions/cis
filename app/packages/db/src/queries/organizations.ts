import { Pool } from 'pg';
import type { InvestorCategoryServed, Organization, OrganizationType } from '@cis/shared-types';
import { query } from '../client';

interface RawOrgRow {
  id: string;
  slug: string;
  display_name: string;
  org_type: string;
  is_active: boolean;
  metadata: Record<string, unknown>;
  investor_categories_served: string[];
  created_at: Date;
  updated_at: Date;
}

function mapOrg(row: RawOrgRow): Organization {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    orgType: row.org_type as OrganizationType,
    isActive: row.is_active,
    metadata: row.metadata,
    investorCategoriesServed: (row.investor_categories_served ?? []) as InvestorCategoryServed[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createOrganization(
  pool: Pool,
  data: { slug: string; displayName: string; orgType: OrganizationType },
): Promise<Organization> {
  const result = await query<RawOrgRow>(
    pool,
    `INSERT INTO organizations (slug, display_name, org_type)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [data.slug, data.displayName, data.orgType],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Organization insert returned no rows');
  return mapOrg(row);
}

export async function getOrganizationById(pool: Pool, id: string): Promise<Organization | null> {
  const result = await query<RawOrgRow>(pool, 'SELECT * FROM organizations WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? mapOrg(row) : null;
}

export async function listOrganizations(pool: Pool): Promise<Organization[]> {
  const result = await query<RawOrgRow>(pool, 'SELECT * FROM organizations ORDER BY display_name');
  return result.rows.map(mapOrg);
}

// ─── Investor categories served (UX-FRM-002) ────────────────────────────────

/**
 * Set the firm's own declaration of investor categories served. This is the
 * ONLY function that writes this column — it is a self-service field edited
 * by the firm's coordinator at any time, with no gate and no downstream
 * effect. Callers must never wire this value into any scoring, eligibility
 * or evidence-pack query.
 */
export async function setInvestorCategoriesServed(
  pool: Pool,
  organizationId: string,
  categories: InvestorCategoryServed[],
): Promise<Organization> {
  const result = await query<RawOrgRow>(
    pool,
    `UPDATE organizations SET investor_categories_served = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [organizationId, categories],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Organization not found for investor-categories update');
  return mapOrg(row);
}

// ─── Edition participation ──────────────────────────────────────────────────

/** Record (or update) an organisation's participation in an edition. */
export async function upsertEditionParticipation(
  pool: Pool,
  data: {
    editionId: string;
    organizationId: string;
    status?: 'invited' | 'active' | 'completed' | 'withdrawn';
  },
): Promise<void> {
  await query(
    pool,
    `INSERT INTO edition_participation (edition_id, organization_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (edition_id, organization_id)
       DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
    [data.editionId, data.organizationId, data.status ?? 'invited'],
  );
}

/**
 * The firms a respondent may actually pick from: organisations that are ACTIVE
 * participants in this edition and themselves active. This is the single source
 * for the firm picker — a firm that only exists in the org table, or is merely
 * `invited`/`withdrawn` for the edition, is never offered.
 */
export async function getActiveEditionParticipants(
  pool: Pool,
  editionId: string,
): Promise<Organization[]> {
  const result = await query<RawOrgRow>(
    pool,
    `SELECT o.*
       FROM organizations o
       JOIN edition_participation ep ON ep.organization_id = o.id
      WHERE ep.edition_id = $1
        AND ep.status = 'active'
        AND o.is_active = TRUE
      ORDER BY o.display_name`,
    [editionId],
  );
  return result.rows.map(mapOrg);
}
