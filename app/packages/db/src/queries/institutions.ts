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
 * The bespoke-instrument roles (client decision, Institutional Instruments for
 * Three New Market Institutions, Sept 2026): one registered institution, one
 * bespoke questionnaire, one attributed passage. Each row names the role's own
 * instrument and its one-line vantage (the instrument's "Strap"). The same
 * values are written to existing databases by migration
 * 20261022000000_institutional-instruments.js.
 */
export const BESPOKE_INSTRUMENT_ROLES: ReadonlyArray<{
  institutionName: string;
  familyCode: InstrumentFamilyCode;
  instrumentCode: string;
  mandate: string;
}> = [
  {
    institutionName: 'Lagos Commodities and Futures Exchange',
    familyCode: 'B',
    instrumentCode: 'I-LCFE',
    mandate: 'Commodities and derivatives view',
  },
  {
    institutionName: 'NASD OTC Securities Exchange',
    familyCode: 'B',
    instrumentCode: 'I-NASD',
    mandate: 'OTC market view',
  },
  {
    institutionName: 'FMDQ Group',
    familyCode: 'B',
    instrumentCode: 'I-FMDQ',
    mandate: 'Fixed income, currencies and post-trade view',
  },
];

/**
 * The instruments the original roles answer, made explicit register
 * assignments (UX-OPS-007 v2.10: instrument assignment comes from the
 * register; a role without one cannot be sent a link).
 */
export const EXISTING_INSTRUMENT_ASSIGNMENTS: ReadonlyArray<{
  institutionName: string;
  familyCode: InstrumentFamilyCode;
  instrumentCode: string;
}> = [
  {
    institutionName: 'Securities and Exchange Commission',
    familyCode: 'A',
    instrumentCode: 'I-SEC',
  },
  { institutionName: 'Nigerian Exchange Limited', familyCode: 'B', instrumentCode: 'I-NGX' },
  {
    institutionName: 'Central Securities Clearing System',
    familyCode: 'C',
    instrumentCode: 'I-CSCS',
  },
  {
    institutionName: 'Central Securities Clearing System',
    familyCode: 'D',
    instrumentCode: 'I-DEP',
  },
];

/**
 * D-16 — role families retired from Version 1. Family D (Depository /
 * Securities-account Infrastructure, questionnaire I-DEP) appears in no
 * approved document: UX-OPS-007 v2.10 maps one registered institution to one
 * bespoke instrument and introduces no new role family, and the six market
 * institutions are SEC, NGX, CSCS, LCFE, NASD and FMDQ. CSCS keeps one role,
 * clearing, settlement and custody (family C, I-CSCS). The rows are kept for
 * provenance, stamped `retired_at`, and every listing skips them. Existing
 * databases are retired by migration 20261023200000_retire-cscs-depository.js.
 */
export const RETIRED_FAMILY_CODES: readonly InstrumentFamilyCode[] = ['D'];

/** Stamp the retired families' roles (idempotent). */
export async function retireRetiredInstitutionRoles(pool: Pool): Promise<void> {
  await query(
    pool,
    `UPDATE institution_roles SET retired_at = NOW()
      WHERE family_code = ANY($1) AND retired_at IS NULL`,
    [RETIRED_FAMILY_CODES],
  );
}

/**
 * Seed the institutions/roles named in the controlled extension's mapping
 * table. Idempotent (ON CONFLICT DO NOTHING on the unique institution name /
 * (institution, family) pair) — safe to call every time `seedReferenceData`
 * runs, exactly like every other piece of reference data it seeds.
 */
export async function seedInstitutions(pool: Pool): Promise<void> {
  // LCFE and NASD OTC are registered (Sept 2026 client decision) and answer
  // their own bespoke instruments. FMDQ registers as ONE entity, FMDQ Group,
  // for this edition; the three FMDQ subsidiaries named in the earlier
  // extension stay unregistered ("not in collection") and keep their rows.
  // `seedInstitutionEngagement` skips inactive institutions.
  await query(
    pool,
    `INSERT INTO institutions (name, is_active) VALUES
       ('Securities and Exchange Commission', TRUE),
       ('Nigerian Exchange Limited', TRUE),
       ('NASD OTC Securities Exchange', TRUE),
       ('Lagos Commodities and Futures Exchange', TRUE),
       ('FMDQ Group', TRUE),
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
       'Lagos Commodities and Futures Exchange', 'FMDQ Group',
       'FMDQ Securities Exchange Limited'
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
  for (const r of EXISTING_INSTRUMENT_ASSIGNMENTS) {
    await query(
      pool,
      `UPDATE institution_roles ir
          SET instrument_code = $3
         FROM institutions i
        WHERE i.id = ir.institution_id AND i.name = $1 AND ir.family_code = $2
          AND ir.instrument_code IS NULL`,
      [r.institutionName, r.familyCode, r.instrumentCode],
    );
  }
  for (const r of BESPOKE_INSTRUMENT_ROLES) {
    await query(
      pool,
      `UPDATE institution_roles ir
          SET instrument_code = $3, mandate = COALESCE(ir.mandate, $4)
         FROM institutions i
        WHERE i.id = ir.institution_id AND i.name = $1 AND ir.family_code = $2
          AND ir.instrument_code IS NULL`,
      [r.institutionName, r.familyCode, r.instrumentCode, r.mandate],
    );
  }
  await retireRetiredInstitutionRoles(pool);
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
  instrument_code: string | null;
  mandate: string | null;
}

function mapRole(r: RawRoleRow): InstitutionRole {
  return {
    institutionId: r.institution_id,
    familyCode: r.family_code,
    instrumentCode: r.instrument_code,
    mandate: r.mandate,
  };
}

/** Every (institution, family) role in the estate — the structural source of
 *  truth for "which institutions participate in which family". */
export async function listInstitutionRoles(pool: Pool): Promise<InstitutionRole[]> {
  const res = await query<RawRoleRow>(
    pool,
    `SELECT institution_id, family_code, instrument_code, mandate FROM institution_roles
      WHERE retired_at IS NULL
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
    `SELECT r.institution_id, r.family_code, r.instrument_code, r.mandate
       FROM institution_roles r
       JOIN institutions i ON i.id = r.institution_id
      WHERE i.is_active = TRUE AND r.retired_at IS NULL
      ORDER BY r.family_code, r.institution_id`,
  );
  return res.rows.map(mapRole);
}

/** Roles held by one institution, retired ones excluded (CSCS: one, family C). */
export async function listRolesForInstitution(
  pool: Pool,
  institutionId: string,
): Promise<InstitutionRole[]> {
  const res = await query<RawRoleRow>(
    pool,
    `SELECT institution_id, family_code, instrument_code, mandate FROM institution_roles
      WHERE institution_id = $1 AND retired_at IS NULL ORDER BY family_code`,
    [institutionId],
  );
  return res.rows.map(mapRole);
}

/** Institutions + their roles joined, for surfaces that need both in one read
 *  (e.g. the mission board's per-role display name). */
export interface InstitutionWithRole extends Institution {
  familyCode: InstrumentFamilyCode;
  instrumentCode: string | null;
  mandate: string | null;
}

export async function listInstitutionsWithRoles(pool: Pool): Promise<InstitutionWithRole[]> {
  const res = await query<
    RawInstitutionRow & {
      family_code: InstrumentFamilyCode;
      instrument_code: string | null;
      mandate: string | null;
    }
  >(
    pool,
    `SELECT i.*, r.family_code, r.instrument_code, r.mandate
       FROM institutions i
       JOIN institution_roles r ON r.institution_id = i.id AND r.retired_at IS NULL
      ORDER BY r.family_code, i.name`,
  );
  return res.rows.map((r) => ({
    ...mapInstitution(r),
    familyCode: r.family_code,
    instrumentCode: r.instrument_code,
    mandate: r.mandate,
  }));
}
