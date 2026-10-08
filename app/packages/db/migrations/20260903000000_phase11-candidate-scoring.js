'use strict';

/**
 * Phase 11 — Candidate Scoring Methodology Integration (CIS-SCORE-2026 v0.14).
 *
 * The methodology is now a real, detailed CANDIDATE — but `status =
 * TEST_UNAPPROVED`. The governing rule: "Build the framework now. Do not invent
 * the methodology." This migration adds the framework's three structural needs:
 *
 *   1. `calculation_runs.methodology_status` — marks a run as produced under an
 *      unapproved methodology. A `TEST_UNAPPROVED` run is barred STRUCTURALLY
 *      from official use (evidence packs, AI generation, released reports) — a
 *      hard gate, not a label. A NULL status is a legacy/normal run (unchanged
 *      behaviour for Phases 5–7). Also widens run_type to allow 'comparison'.
 *
 *   2. `calculated_results` gains the `NOT_CALCULABLE` sufficiency state — a
 *      DISTINCT state from SUPPRESSED. SUPPRESSED is a data problem (more
 *      fieldwork fixes it); NOT_CALCULABLE here is a methodology problem (only a
 *      methodology-partner approval fixes it, e.g. Industry SEI's unset
 *      `industry_sei_min_firm_investor_observations`). It carries no value.
 *
 *   3. `comparison_runs` — the like-for-like cross-edition recalculation
 *      (LIKE_FOR_LIKE_RECALCULATED). A comparison run references two prior signed
 *      runs, restates both on the common reportable segment set, and preserves
 *      both original published headlines. Immutable; never mutates a source run.
 *
 * Reversible. Schema only; the candidate config is loaded from the authoritative
 * YAML by a parameterized loader (no embedded duplicate — methodology spec §18).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── calculation_runs: methodology status + comparison run type ───────────────
  pgm.sql(`
    ALTER TABLE calculation_runs
      ADD COLUMN methodology_status TEXT
        CHECK (methodology_status IN ('TEST_UNAPPROVED','APPROVED'))
  `);
  pgm.sql(`ALTER TABLE calculation_runs DROP CONSTRAINT IF EXISTS calculation_runs_run_type_check`);
  pgm.sql(`
    ALTER TABLE calculation_runs
      ADD CONSTRAINT calculation_runs_run_type_check
      CHECK (run_type IN ('eligibility','scoring','comparison'))
  `);

  // ── calculated_results: NOT_CALCULABLE (methodology block ≠ data suppression) ─
  pgm.sql(
    `ALTER TABLE calculated_results DROP CONSTRAINT IF EXISTS calculated_results_sufficiency_state_check`,
  );
  pgm.sql(`
    ALTER TABLE calculated_results
      ADD CONSTRAINT calculated_results_sufficiency_state_check
      CHECK (sufficiency_state IN ('REPORTABLE','DIRECTIONAL','BANDED','SUPPRESSED','NOT_CALCULABLE'))
  `);
  // A NOT_CALCULABLE result carries neither value nor band (nothing was computed).
  pgm.sql(`
    ALTER TABLE calculated_results
      ADD CONSTRAINT calculated_results_not_calculable_null
      CHECK (sufficiency_state <> 'NOT_CALCULABLE' OR (value IS NULL AND band IS NULL))
  `);

  // ── comparison_runs (like-for-like) ──────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE comparison_runs (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_a_id        UUID        NOT NULL REFERENCES editions(id),
      edition_b_id        UUID        NOT NULL REFERENCES editions(id),
      run_a_id            UUID        NOT NULL REFERENCES calculation_runs(id),
      run_b_id            UUID        NOT NULL REFERENCES calculation_runs(id),
      metric_code         TEXT        NOT NULL,
      methodology_version TEXT        NOT NULL,
      common_segments     JSONB       NOT NULL,
      label               TEXT        NOT NULL DEFAULT 'LIKE_FOR_LIKE_RECALCULATED'
                                      CHECK (label = 'LIKE_FOR_LIKE_RECALCULATED'),
      original_headline_a NUMERIC,
      original_headline_b NUMERIC,
      recalculated_a      NUMERIC,
      recalculated_b      NUMERIC,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(
    `CREATE INDEX idx_comparison_runs_editions ON comparison_runs(edition_a_id, edition_b_id)`,
  );
  // Immutable — a comparison run is a permanent, reproducible artefact.
  pgm.sql(`CREATE TRIGGER comparison_runs_no_update BEFORE UPDATE ON comparison_runs
           FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()`);
  pgm.sql(`CREATE TRIGGER comparison_runs_no_delete BEFORE DELETE ON comparison_runs
           FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS comparison_runs`);
  pgm.sql(
    `ALTER TABLE calculated_results DROP CONSTRAINT IF EXISTS calculated_results_not_calculable_null`,
  );
  pgm.sql(
    `ALTER TABLE calculated_results DROP CONSTRAINT IF EXISTS calculated_results_sufficiency_state_check`,
  );
  pgm.sql(`
    ALTER TABLE calculated_results
      ADD CONSTRAINT calculated_results_sufficiency_state_check
      CHECK (sufficiency_state IN ('REPORTABLE','DIRECTIONAL','BANDED','SUPPRESSED'))
  `);
  pgm.sql(`ALTER TABLE calculation_runs DROP CONSTRAINT IF EXISTS calculation_runs_run_type_check`);
  pgm.sql(`
    ALTER TABLE calculation_runs
      ADD CONSTRAINT calculation_runs_run_type_check
      CHECK (run_type IN ('eligibility','scoring'))
  `);
  pgm.sql(`ALTER TABLE calculation_runs DROP COLUMN IF EXISTS methodology_status`);
};
