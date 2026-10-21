'use strict';

/**
 * Three go-live guards on official output.
 *
 * 1. `calculation_runs.methodology_status` is never left blank. Until now a run
 *    inserted without a status was NULL, and NULL was read as "a normal run" —
 *    so the provisional placeholder scoring, made while the methodology was
 *    still unapproved, could be signed off and reach a report. Now:
 *      - BEFORE INSERT, a run with no status is stamped TEST_UNAPPROVED unless
 *        two people have approved the scoring methodology (the
 *        `scoring_methodology_approval` critical action), in which case it is
 *        APPROVED. A run stamped APPROVED while no approval exists is refused.
 *        When the run carries a candidate methodology version (`ID@x.y`), the
 *        approval must be for that exact version.
 *      - A run's status can never change after insert (a run is immutable).
 *      - The column becomes NOT NULL.
 *    Existing NULL rows are backfilled (a label correction, not a change to any
 *    figure): a scoring/comparison run is TEST_UNAPPROVED (none of them was made
 *    by the approved methodology — that path has always stamped APPROVED
 *    itself); an eligibility run is APPROVED if it was made after the
 *    methodology approval, otherwise TEST_UNAPPROVED.
 *
 * 2. `national_report_openings` — who opened the national report's draft. The
 *    approver of the national report must have opened it themselves; the old
 *    report-level `draft_opened` flag could be set by anyone.
 *
 * 3. `report_snapshots` — the content of a report frozen at the moment it
 *    leaves CIS (a firm report on release, the Industry report on
 *    publication): every figure, the indices, the scoring run they came from
 *    and its methodology version. A released report is always served from its
 *    snapshot, so signing off a later run never changes it. One snapshot per
 *    released firm report VERSION (a correction is a new version with its own
 *    snapshot) and one per edition for the Industry report. Permanent: no
 *    UPDATE or DELETE.
 *
 * Down: drops the triggers, the NOT NULL and the two tables. The backfilled
 * statuses are NOT reverted to NULL — NULL was the defect, and the stamp is a
 * true statement about how those runs were made.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── 1. Runs: no blank methodology status, ever ──────────────────────────────
  pgm.sql(`
    CREATE OR REPLACE FUNCTION methodology_approved_for(run_version TEXT)
    RETURNS BOOLEAN AS $$
      SELECT EXISTS (
        SELECT 1 FROM critical_actions a
         WHERE a.action_type = 'scoring_methodology_approval'
           AND a.status = 'approved'
           AND (
             run_version IS NULL
             OR run_version !~ '^[A-Za-z0-9_-]+@[0-9][0-9.]*$'
             OR (a.payload->>'methodologyId') || '@' || (a.payload->>'version') = run_version
           )
      )
    $$ LANGUAGE sql STABLE
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION stamp_run_methodology_status()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.methodology_status IS NULL THEN
        NEW.methodology_status := CASE
          WHEN methodology_approved_for(NEW.methodology_version) THEN 'APPROVED'
          ELSE 'TEST_UNAPPROVED'
        END;
      ELSIF NEW.methodology_status = 'APPROVED'
            AND NOT methodology_approved_for(NEW.methodology_version) THEN
        RAISE EXCEPTION 'calculation run cannot be APPROVED: the scoring methodology has not been approved'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  pgm.sql(`
    CREATE TRIGGER calculation_runs_stamp_methodology_status
      BEFORE INSERT ON calculation_runs
      FOR EACH ROW EXECUTE FUNCTION stamp_run_methodology_status()
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_run_methodology_status_change()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.methodology_status IS DISTINCT FROM OLD.methodology_status THEN
        RAISE EXCEPTION 'calculation run %: methodology_status is fixed when the run is made', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  pgm.sql(`
    CREATE TRIGGER calculation_runs_methodology_status_fixed
      BEFORE UPDATE OF methodology_status ON calculation_runs
      FOR EACH ROW EXECUTE FUNCTION prevent_run_methodology_status_change()
  `);

  // Backfill (label correction) before the NOT NULL.
  pgm.sql(`
    UPDATE calculation_runs r
       SET methodology_status = CASE
         WHEN r.run_type = 'eligibility' AND EXISTS (
           SELECT 1 FROM critical_actions a
            WHERE a.action_type = 'scoring_methodology_approval'
              AND a.status = 'approved'
              AND a.approved_at <= r.created_at
         ) THEN 'APPROVED'
         ELSE 'TEST_UNAPPROVED'
       END
     WHERE r.methodology_status IS NULL
  `);
  pgm.sql(`ALTER TABLE calculation_runs ALTER COLUMN methodology_status SET NOT NULL`);

  // ── 2. Who opened the national report's draft ───────────────────────────────
  pgm.sql(`
    CREATE TABLE national_report_openings (
      national_report_id UUID        NOT NULL REFERENCES national_reports(id),
      user_id            UUID        NOT NULL REFERENCES users(id),
      first_opened_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (national_report_id, user_id)
    )
  `);

  // ── 3. Released reports, frozen ─────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE report_snapshots (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id          UUID        NOT NULL REFERENCES editions(id),
      kind                TEXT        NOT NULL CHECK (kind IN ('industry', 'firm')),
      subject_id          UUID        REFERENCES organizations(id),
      firm_report_id      UUID        REFERENCES firm_reports(id),
      firm_report_version INTEGER,
      national_report_id  UUID        REFERENCES national_reports(id),
      scoring_run_id      UUID        REFERENCES calculation_runs(id),
      methodology_version TEXT,
      methodology_status  TEXT,
      content             JSONB       NOT NULL,
      created_by          TEXT        NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((kind = 'firm') = (subject_id IS NOT NULL)),
      CHECK ((kind = 'firm') = (firm_report_id IS NOT NULL))
    )
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX uq_report_snapshots_firm_report
      ON report_snapshots (firm_report_id) WHERE kind = 'firm'
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX uq_report_snapshots_industry
      ON report_snapshots (edition_id) WHERE kind = 'industry'
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_report_snapshot_change()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'report_snapshot % is permanent: % is not permitted', OLD.id, TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `);
  pgm.sql(`
    CREATE TRIGGER report_snapshots_no_change
      BEFORE UPDATE OR DELETE ON report_snapshots
      FOR EACH ROW EXECUTE FUNCTION prevent_report_snapshot_change()
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS report_snapshots`);
  pgm.sql(`DROP FUNCTION IF EXISTS prevent_report_snapshot_change()`);
  pgm.sql(`DROP TABLE IF EXISTS national_report_openings`);
  pgm.sql(`ALTER TABLE calculation_runs ALTER COLUMN methodology_status DROP NOT NULL`);
  pgm.sql(`DROP TRIGGER IF EXISTS calculation_runs_methodology_status_fixed ON calculation_runs`);
  pgm.sql(`DROP FUNCTION IF EXISTS prevent_run_methodology_status_change()`);
  pgm.sql(`DROP TRIGGER IF EXISTS calculation_runs_stamp_methodology_status ON calculation_runs`);
  pgm.sql(`DROP FUNCTION IF EXISTS stamp_run_methodology_status()`);
  pgm.sql(`DROP FUNCTION IF EXISTS methodology_approved_for(TEXT)`);
};
