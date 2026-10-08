'use strict';

/**
 * Phase 13 — Responses Monitoring (UX-OPS-003) & Reminder Timing (UX-OPS-004).
 *
 * UX-OPS-003 is the retroactive design authority for the funnel-event stream and
 * the report-dependency map — both already exist (Phases 5/10). This migration
 * adds the two structural needs the two surfaces introduce:
 *
 *   1. `report_dependency.required_instruments` — an EXPLICIT, required declaration
 *      of which firm-side instruments a firm-referencing output needs (UX-OPS-003
 *      §B7). Two firm-side sufficiency states are tracked — complete firms
 *      (S1+S2+S3) and DMI-complete (S1+S3) — and an output must declare which it
 *      needs, not fall back to whichever population is convenient at write time.
 *      Nullable: investor-only outputs declare no firm-side instruments.
 *
 *   2. `reminder_send` — the send-sequence ledger for UX-OPS-004. It records that
 *      an investor-side response was scheduled a reminder at a step, with the STOP
 *      flag (carried on every reminder after the first). It drives the cap and the
 *      first-vs-subsequent STOP flag; the ENGINE never touches response state.
 *      Append-only (a send is a historical fact).
 *
 * The reminder SCHEDULE and CAP themselves are governed configuration
 * (`reminders.schedule`, `reminders.cap`), seeded via GOVERNED_CONFIG_DEFAULTS —
 * not schema, so the study team edits them without a build.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── report_dependency: explicit firm-side instrument declaration ─────────────
  pgm.sql(`ALTER TABLE report_dependency ADD COLUMN required_instruments JSONB`);

  // ── reminder_send: the send-sequence ledger (investor-side only) ─────────────
  pgm.sql(`
    CREATE TABLE reminder_send (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id    UUID        NOT NULL REFERENCES editions(id),
      response_id   UUID        NOT NULL REFERENCES respondents(id),
      step          INTEGER     NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      carries_stop  BOOLEAN     NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (edition_id, response_id, step)
    )
  `);
  pgm.sql(`CREATE INDEX idx_reminder_send_response ON reminder_send (edition_id, response_id)`);
  // Append-only — a reminder send is a historical fact, never edited or deleted.
  pgm.sql(`CREATE TRIGGER reminder_send_no_update BEFORE UPDATE ON reminder_send
           FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()`);
  pgm.sql(`CREATE TRIGGER reminder_send_no_delete BEFORE DELETE ON reminder_send
           FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS reminder_send`);
  pgm.sql(`ALTER TABLE report_dependency DROP COLUMN IF EXISTS required_instruments`);
};
