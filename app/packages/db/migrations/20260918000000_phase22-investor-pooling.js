'use strict';

/**
 * Phase 22 — Investor-Unit Scoring Pipeline (CIS-SCORE-2026 v0.15, §7.5/§8.5/§9).
 *
 * `calculated_results` gains a single nullable `composition` JSONB column, used
 * ONLY by a pooled public headline result (`subject_type='market'`,
 * `metric_code` IN ('IEI','ICI')). It records exactly the structured disclosure
 * §9 requires: which segments actually contributed and their achieved unit
 * counts. A non-contributing segment is OMITTED from the array entirely — never
 * present with a zero count — matching the methodology's own wording ("a
 * segment that does not contribute... is omitted from the headline composition
 * line"). NULL for every other result row (firm-side DMI/OMI/SEI, etc.) — this
 * is additive, structured metadata for one specific result shape, not a
 * second general-purpose column repurposed loosely.
 *
 * Reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`ALTER TABLE calculated_results ADD COLUMN composition JSONB`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`ALTER TABLE calculated_results DROP COLUMN IF EXISTS composition`);
};
