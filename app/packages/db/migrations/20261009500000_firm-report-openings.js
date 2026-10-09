'use strict';

/**
 * Firm reports — who has opened each report before it is approved for release.
 *
 * Releasing the firm reports is one of the six critical actions: one person
 * requests it with a reason, a different person approves it, and approving
 * releases them. Every report covered by a request must have been opened by
 * the requester or the approver before the approval is accepted — the same
 * "open it before you approve it" rule the national report applies to its
 * draft. This table is that record: one row per (report, operator), the first
 * time that operator opened it. Reading a report again changes nothing.
 *
 * Additive and reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE firm_report_openings (
      firm_report_id  UUID        NOT NULL REFERENCES firm_reports(id),
      user_id         UUID        NOT NULL REFERENCES users(id),
      first_opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firm_report_id, user_id)
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS firm_report_openings`);
};
