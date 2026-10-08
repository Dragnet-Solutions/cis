'use strict';

/**
 * Phase 24 — Scoring sign-off gains a reject capability.
 *
 * Every other maker-checker action on the platform (edition lock, instrument
 * freeze via `critical_actions`; the national report) can be rejected by the
 * checker, with a reason, by someone other than the requester. Scoring
 * sign-off (`scoring_signoffs`, Phase 7) could only be approved — a checker
 * with concerns had no way to record that decision; the request just sat
 * `requested` forever. This adds `rejected` alongside `signed_off`, using the
 * same `rejected_by`/`rejected_at`/`rejection_reason` column names Phase 0's
 * `critical_actions` already established, and the same requester-cannot-be-
 * rejecter CHECK constraint the table already enforces for approval.
 *
 * A rejected sign-off is not "live" (same treatment as `superseded`), so
 * `uniq_live_signoff_per_run` already lets a maker submit a fresh request
 * for the same run after a rejection — no index change needed.
 *
 * Reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE scoring_signoffs
      ADD COLUMN rejected_by     TEXT,
      ADD COLUMN rejected_at     TIMESTAMPTZ,
      ADD COLUMN rejection_reason TEXT
  `);

  pgm.sql(`ALTER TABLE scoring_signoffs DROP CONSTRAINT IF EXISTS scoring_signoffs_state_check`);
  pgm.sql(`
    ALTER TABLE scoring_signoffs
      ADD CONSTRAINT scoring_signoffs_state_check
      CHECK (state IN ('requested','signed_off','superseded','rejected'))
  `);

  // Maker-checker: the rejecter is never the requester. Same shape as the
  // existing approved_by CHECK.
  pgm.sql(`
    ALTER TABLE scoring_signoffs
      ADD CONSTRAINT scoring_signoffs_rejected_by_not_requester
      CHECK (rejected_by IS NULL OR rejected_by <> requested_by)
  `);

  // A rejected row must carry its rejecter, reason, and timestamp; a
  // non-rejected row must not. Mirrors the existing signed_off CHECK.
  pgm.sql(`
    ALTER TABLE scoring_signoffs
      ADD CONSTRAINT scoring_signoffs_rejected_fields_check
      CHECK (
        (state = 'rejected' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL
          AND rejection_reason IS NOT NULL AND length(trim(rejection_reason)) > 0)
        OR (state <> 'rejected')
      )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(
    `ALTER TABLE scoring_signoffs DROP CONSTRAINT IF EXISTS scoring_signoffs_rejected_fields_check`,
  );
  pgm.sql(
    `ALTER TABLE scoring_signoffs DROP CONSTRAINT IF EXISTS scoring_signoffs_rejected_by_not_requester`,
  );
  pgm.sql(`ALTER TABLE scoring_signoffs DROP CONSTRAINT IF EXISTS scoring_signoffs_state_check`);
  pgm.sql(`
    ALTER TABLE scoring_signoffs
      ADD CONSTRAINT scoring_signoffs_state_check
      CHECK (state IN ('requested','signed_off','superseded'))
  `);
  pgm.sql(`
    ALTER TABLE scoring_signoffs
      DROP COLUMN IF EXISTS rejected_by,
      DROP COLUMN IF EXISTS rejected_at,
      DROP COLUMN IF EXISTS rejection_reason
  `);
};
