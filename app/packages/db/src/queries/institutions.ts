import { Pool } from 'pg';
import type { Institution, InstitutionRole, InstrumentFamilyCode } from '@cis/shared-types';
import { query } from '../client';

/**
 * Phase 19 — institutions and the roles they hold. Adding a ninth institution
 * of an existing family is a new row here, never a code change: every
 * consumer (regulator engagement, mission board, invitations audience) reads
 * this table rather than a hardcoded enum.
 */

interface RawInstitutionRow {
  id: string;
  name: string;
  is_active: boolean;
  created_at: Date;
}

function mapInstitution(r: RawInstitutionRow): Institution {
  return { id: r.id, name: r.name, isActive: r.is_active, createdAt: r.created_at };
}

/**
 * Seed the institutions/roles named in the controlled extension's mapping
 * table. Idempotent (ON CONFLICT DO NOTHING on the unique institution name /
 * (institution, family) pair) — safe to call every time `seedReferenceData`
 * runs, exactly like every other piece of reference data it seeds.
 */
export async function seedInstitutions(pool: Pool): Promise<void> {
  // LCFE, NASD OTC and the three FMDQ entities are under CIS review — "not
  // registered and not in collection" per the Engineering Screen Stitching
  // Guide §8. Seeded inactive; `seedInstitutionEngagement` skips inactive
  // institutions, so they carry no engagement row until CIS registers them
  // and someone flips this flag — a data change, not a code change.
  await query(
    pool,
    `INSERT INTO institutions (name, is_active) VALUES
       ('Securities and Exchange Commission', TRUE),
       ('Nigerian Exchange Limited', TRUE),
       ('NASD OTC Securities Exchange', FALSE),
       ('Lagos Commodities and Futures Exchange', FALSE),
       ('FMDQ Securities Exchange Limited', FALSE),
       ('Central Securities Clearing System', TRUE),
       ('FMDQ Clear Limited', FALSE),
       ('FMDQ Depository Limited', FALSE)
     ON CONFLICT (name) DO NOTHING`,
  );
  await query(
    pool,
    `INSERT INTO institution_roles (institution_id, family_code)
     SELECT id, 'A' FROM institutions WHERE name = 'Securities and Exchange Commission'
     UNION ALL
     SELECT id, 'B' FROM institutions WHERE name IN (
       'Nigerian Exchange Limited', 'NASD OTC Securities Exchange',
       'Lagos Commodities and Futures Exchange', 'FMDQ Securities Exchange Limited'
     )
     UNION ALL
     SELECT id, 'C' FROM institutions WHERE name IN (
       'Central Securities Clearing System', 'FMDQ Clear Limited'
     )
     UNION ALL
     SELECT id, 'D' FROM institutions WHERE name IN (
       'Central Securities Clearing System', 'FMDQ Depository Limited'
     )
     ON CONFLICT (institution_id, family_code) DO NOTHING`,
  );
}

export async function listInstitutions(pool: Pool): Promise<Institution[]> {
  const res = await query<RawInstitutionRow>(pool, 'SELECT * FROM institutions ORDER BY name');
  return res.rows.map(mapInstitution);
}

export async function getInstitutionById(pool: Pool, id: string): Promise<Institution | null> {
  const res = await query<RawInstitutionRow>(pool, 'SELECT * FROM institutions WHERE id = $1', [
    id,
  ]);
  const row = res.rows[0];
  return row ? mapInstitution(row) : null;
}

interface RawRoleRow {
  institution_id: string;
  family_code: InstrumentFamilyCode;
}

function mapRole(r: RawRoleRow): InstitutionRole {
  return { institutionId: r.institution_id, familyCode: r.family_code };
}

/** Every (institution, family) role in the estate — the structural source of
 *  truth for "which institutions participate in which family". */
export async function listInstitutionRoles(pool: Pool): Promise<InstitutionRole[]> {
  const res = await query<RawRoleRow>(
    pool,
    `SELECT institution_id, family_code FROM institution_roles
      ORDER BY family_code, institution_id`,
  );
  return res.rows.map(mapRole);
}

/** Every (institution, family) role for an institution CIS has actually
 *  registered — excludes institutions under CIS review (`is_active = false`).
 *  This is what `seedInstitutionEngagement` reads, so an institution "not
 *  registered and not in collection" (Screen Stitching Guide §8) gets no
 *  engagement row until CIS registers it. */
export async function listActiveInstitutionRoles(pool: Pool): Promise<InstitutionRole[]> {
  const res = await query<RawRoleRow>(
    pool,
    `SELECT r.institution_id, r.family_code
       FROM institution_roles r
       JOIN institutions i ON i.id = r.institution_id
      WHERE i.is_active = TRUE
      ORDER BY r.family_code, r.institution_id`,
  );
  return res.rows.map(mapRole);
}

/** Roles held by one institution (CSCS: two rows, C and D). */
export async function listRolesForInstitution(
  pool: Pool,
  institutionId: string,
): Promise<InstitutionRole[]> {
  const res = await query<RawRoleRow>(
    pool,
    `SELECT institution_id, family_code FROM institution_roles
      WHERE institution_id = $1 ORDER BY family_code`,
    [institutionId],
  );
  return res.rows.map(mapRole);
}

/** Institutions + their roles joined, for surfaces that need both in one read
 *  (e.g. the mission board's per-role display name). */
export interface InstitutionWithRole extends Institution {
  familyCode: InstrumentFamilyCode;
}

export async function listInstitutionsWithRoles(pool: Pool): Promise<InstitutionWithRole[]> {
  const res = await query<RawInstitutionRow & { family_code: InstrumentFamilyCode }>(
    pool,
    `SELECT i.*, r.family_code
       FROM institutions i
       JOIN institution_roles r ON r.institution_id = i.id
      ORDER BY r.family_code, i.name`,
  );
  return res.rows.map((r) => ({ ...mapInstitution(r), familyCode: r.family_code }));
}
