'use strict';

/**
 * Phase 12 — Regulator Engagement (UX-OPS-007).
 *
 * This surface formally OWNS what Phases 9 and 10 left provisional:
 *   - Phase 10's `institution_engagement` already holds per-(edition, regulator)
 *     `status` and `target_by`. `target_by` was flagged DECISION NEEDED with no
 *     owning UI — this surface is that UI, so the writes land HERE, not in a
 *     second parallel date field. We extend the same row with the regulator's
 *     named contact and the issued survey link, so one row is the whole record.
 *   - Phase 9's `regulator_contacts` was a provisional stub "pending UX-OPS-007";
 *     the authoritative, per-edition, fully-detailed contact now lives on the
 *     engagement row. (The Phase 9 stub is left in place for its invitations
 *     audience; see the README note.)
 *
 * A regulator's named contact (who / role / email / phone / how) is the ONE
 * deliberate place in the estate that holds a named individual outside the firm
 * register — engagement is a relationship. It is NOT tokenised.
 *
 * The survey link is a REAL per-regulator access token into the UX-INS-003
 * runtime: `respondent_id` points at a respondents row for the I-{code}
 * instrument whose recovery_token resolves via GET /journeys/resume/:token.
 *
 * History is an append-only free-text log (a phone call produces free text, not
 * a taxonomy) — immutable once written.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── The named contact + issued link, on the existing engagement row ──────────
  pgm.sql(`
    ALTER TABLE institution_engagement
      ADD COLUMN contact_who   TEXT,
      ADD COLUMN contact_role  TEXT,
      ADD COLUMN contact_email TEXT,
      ADD COLUMN contact_phone TEXT,
      ADD COLUMN contact_how   TEXT,
      ADD COLUMN survey_link   TEXT,
      ADD COLUMN respondent_id UUID REFERENCES respondents(id)
  `);

  // ── Append-only free-text engagement history ─────────────────────────────────
  pgm.sql(`
    CREATE TABLE regulator_engagement_history (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id  UUID        NOT NULL REFERENCES editions(id),
      institution TEXT        NOT NULL CHECK (institution IN ('SEC','NGX','CSCS')),
      entry       TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`
    CREATE INDEX idx_reg_history_lookup
      ON regulator_engagement_history (edition_id, institution, created_at)
  `);
  // Immutable — the history is the record of a relationship; entries are never
  // edited or deleted (a correction is a new entry).
  pgm.sql(`CREATE TRIGGER reg_history_no_update BEFORE UPDATE ON regulator_engagement_history
           FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()`);
  pgm.sql(`CREATE TRIGGER reg_history_no_delete BEFORE DELETE ON regulator_engagement_history
           FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS regulator_engagement_history`);
  pgm.sql(`
    ALTER TABLE institution_engagement
      DROP COLUMN IF EXISTS contact_who,
      DROP COLUMN IF EXISTS contact_role,
      DROP COLUMN IF EXISTS contact_email,
      DROP COLUMN IF EXISTS contact_phone,
      DROP COLUMN IF EXISTS contact_how,
      DROP COLUMN IF EXISTS survey_link,
      DROP COLUMN IF EXISTS respondent_id
  `);
};
