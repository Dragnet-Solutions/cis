'use strict';

/**
 * BUG-02 (27 Oct fix list): the scoring methodology's approval belongs to an
 * edition, and scoring no longer waits on it.
 *
 * Bobby's 25 Oct direction: CIS approves the methodology offline. The
 * platform keeps the two-person approval as a RECORD for each edition (who
 * asked, who approved, why, which version), but a scoring run made by the
 * real methodology is official without it.
 *
 * 1. Existing approvals were stored with no edition. Each is attached to the
 *    edition it was given in: the newest edition created at or before the
 *    request (else the oldest edition). A label correction on a column that
 *    was always meant to hold it — no figure changes. A new edition then
 *    starts with no approval record of its own.
 *
 * 2. The run guard (20261021000500) refused a run stamped APPROVED unless a
 *    platform approval existed. It now also accepts a run that names the real
 *    methodology version (`ID@x.y`) — only the candidate-methodology scoring
 *    path stamps those. The provisional placeholder scoring (no versioned
 *    methodology) still cannot be stamped APPROVED without an approval, and a
 *    run left unstamped is stamped exactly as before.
 *
 * Down: restores the previous guard. The edition back-fill is kept (it is a
 * true statement about when each approval was given).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    UPDATE critical_actions a
       SET edition_id = COALESCE(
         (SELECT e.id FROM editions e
           WHERE e.created_at <= a.requested_at
           ORDER BY e.created_at DESC LIMIT 1),
         (SELECT e.id FROM editions e ORDER BY e.created_at ASC LIMIT 1)
       )
     WHERE a.action_type = 'scoring_methodology_approval'
       AND a.edition_id IS NULL
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
            AND NOT (
              COALESCE(NEW.methodology_version ~ '^[A-Za-z0-9_-]+@[0-9][0-9.]*$', FALSE)
              OR methodology_approved_for(NEW.methodology_version)
            ) THEN
        RAISE EXCEPTION 'calculation run cannot be APPROVED: it was not made by the scoring methodology'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
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
};
