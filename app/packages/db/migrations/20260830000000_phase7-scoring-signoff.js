'use strict';

/**
 * Phase 7 — Setup: Results, Scores (sign-off) (UX-ADM-004) + Phase 6 gap fix.
 *
 * The maker-checker gate on the single most consequential action in the
 * platform: which scoring run becomes official. Phase 5 already gives us the
 * immutable run/result model (calculation_runs, calculated_results); this phase
 * adds the SIGN-OFF RECORD that designates which run is authoritative, and the
 * two structural rules the surface depends on:
 *
 *   1. `scoring_signoffs` — a request→approval record over a calculation_run.
 *      The stored record IS the check: it carries a STRUCTURED account of what
 *      the signer verified (checked_account JSONB), not a bare free-text reason.
 *      A maker can never approve their own sign-off (DB CHECK). A later run only
 *      supersedes an earlier signed one WHEN THE NEW ONE IS SIGNED OFF — the
 *      superseded row is marked, never deleted (scoring history is permanent).
 *
 *   2. A 0–100 range CHECK on calculated_results.value — scores are on the
 *      signed framework's 0–100 scale, encoded structurally rather than left as
 *      an implicit assumption. An out-of-range value is a validation_error, not
 *      a silently-stored figure.
 *
 * Per-index POPULATION predicates (OMI = all three seats complete; DMI = S1+S3
 * only) are configuration in metric_definitions.config (seeded by a loader),
 * NOT schema — so nothing about them is hardcoded here.
 *
 * Reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── scoring_signoffs ─────────────────────────────────────────────────────────
  // One row per sign-off request over a scoring run. States:
  //   requested   — a maker submitted the structured checked-account; awaiting a
  //                 second person.
  //   signed_off  — a different person approved. This run is now authoritative.
  //   superseded  — a LATER run for the same edition was signed off, so this one
  //                 is no longer the authoritative run. It stays visible.
  // requested_by / approved_by are operator identifiers (TEXT — same convention
  // as national_reports.requested_by), not FK to users, so the surface is not
  // coupled to the RBAC seed shape.
  pgm.sql(`
    CREATE TABLE scoring_signoffs (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id         UUID        NOT NULL REFERENCES editions(id),
      calculation_run_id UUID        NOT NULL REFERENCES calculation_runs(id),
      state              TEXT        NOT NULL DEFAULT 'requested'
                                     CHECK (state IN ('requested','signed_off','superseded')),
      -- The structured account of WHAT WAS CHECKED. Never a bare reason string;
      -- the shape is validated in the domain layer, and NOT NULL here so a
      -- sign-off can never exist without a recorded account.
      checked_account    JSONB       NOT NULL,
      requested_by       TEXT        NOT NULL,
      requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_by        TEXT,
      approved_at        TIMESTAMPTZ,
      -- Which later sign-off superseded this one (the run it points at), plus when.
      superseded_by      UUID        REFERENCES scoring_signoffs(id),
      superseded_at      TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Maker-checker: the approver is never the requester. Enforced at the data
      -- layer, not only in the service.
      CHECK (approved_by IS NULL OR approved_by <> requested_by),
      -- A signed-off row must carry its approver; a still-requested row must not.
      CHECK (
        (state = 'signed_off' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
        OR (state <> 'signed_off')
      )
    )
  `);
  pgm.sql(`CREATE INDEX idx_scoring_signoffs_edition ON scoring_signoffs(edition_id, state)`);
  pgm.sql(`CREATE INDEX idx_scoring_signoffs_run ON scoring_signoffs(calculation_run_id)`);
  // At most one live (requested or signed_off) sign-off per run — a run is
  // authoritative or awaiting approval once, not many times over. Superseded
  // rows are exempt so history accumulates freely.
  pgm.sql(`
    CREATE UNIQUE INDEX uniq_live_signoff_per_run
      ON scoring_signoffs(calculation_run_id)
      WHERE state IN ('requested','signed_off')
  `);

  // ── calculated_results: scores are on the 0–100 scale ────────────────────────
  // Encoded structurally rather than assumed. A SUPPRESSED/BANDED result already
  // carries a NULL value (Phase 5 CHECKs); this bounds every value that IS present.
  pgm.sql(`
    ALTER TABLE calculated_results
      ADD CONSTRAINT calculated_results_value_range
      CHECK (value IS NULL OR (value >= 0 AND value <= 100))
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(
    `ALTER TABLE calculated_results DROP CONSTRAINT IF EXISTS calculated_results_value_range`,
  );
  pgm.sql(`DROP TABLE IF EXISTS scoring_signoffs`);
};
