'use strict';

/**
 * D-16 — retire the depository role (family D) and its questionnaire I-DEP.
 *
 * Approved design UX-OPS-007 v2.10: "One registered institution maps to one
 * bespoke institutional instrument for Version 1. No new role-family
 * abstraction is introduced." The Scoring Engine build note names six market
 * institutions (SEC, NGX, CSCS, LCFE, NASD, FMDQ), and the CIS-approved
 * LCFE/NASD/FMDQ document records a separate depository questionnaire as
 * premature. No approved document contains I-DEP. CSCS keeps ONE role:
 * clearing, settlement and custody (family C), answering I-CSCS.
 *
 * Nothing is deleted. A nullable `retired_at` is added to
 *   - instrument_definitions  (I-DEP stays in the register for provenance;
 *                              any snapshot already frozen into an edition is
 *                              left in place, and ignored wherever the
 *                              snapshot set is read)
 *   - institution_roles       (every family D role: CSCS's depository role
 *                              and the unregistered FMDQ Depository Limited's)
 *   - institution_engagement  (the engagement rows of those roles, per edition)
 * and every listing filters on it.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS; only rows not yet retired are
 * stamped). Reversible: down re-activates everything and drops the columns.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE instrument_definitions ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
    ALTER TABLE institution_roles ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
    ALTER TABLE institution_engagement ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

    UPDATE instrument_definitions SET retired_at = NOW()
     WHERE code = 'I-DEP' AND retired_at IS NULL;

    UPDATE institution_roles SET retired_at = NOW()
     WHERE family_code = 'D' AND retired_at IS NULL;

    UPDATE institution_engagement e SET retired_at = NOW()
      FROM institution_roles r
     WHERE r.institution_id = e.institution_id AND r.family_code = e.family_code
       AND r.retired_at IS NOT NULL AND e.retired_at IS NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE institution_engagement DROP COLUMN IF EXISTS retired_at;
    ALTER TABLE institution_roles DROP COLUMN IF EXISTS retired_at;
    ALTER TABLE instrument_definitions DROP COLUMN IF EXISTS retired_at;
  `);
};
