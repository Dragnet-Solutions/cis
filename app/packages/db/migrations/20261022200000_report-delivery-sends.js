'use strict';

/**
 * D-04 — the published report, emailed to the investors who asked for it.
 *
 * One row per (publication, respondent): the ledger that the report email for a
 * publication was queued for that respondent. Rows are written ON CONFLICT DO
 * NOTHING in the same transaction as the outbox email, and only newly written
 * rows get an email — so retrying, or publishing again, never sends twice.
 * A publication is permanent (report_publications), so a respondent gets the
 * report once per edition.
 *
 * Additive and reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE report_delivery_sends (
      publication_id UUID        NOT NULL REFERENCES report_publications(id),
      respondent_id  UUID        NOT NULL REFERENCES respondents(id) ON DELETE CASCADE,
      sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (publication_id, respondent_id)
    );
    CREATE INDEX idx_report_delivery_sends_respondent ON report_delivery_sends (respondent_id);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS report_delivery_sends;`);
};
