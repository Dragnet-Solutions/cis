'use strict';

/**
 * AI-drafted report narrative — the prose of the Industry report and of each
 * firm's private report, written by the inference model from the report's own
 * computed figures (report-content-service.ts) and checked sentence by sentence
 * before it is shown.
 *
 * One row per generation; the latest row for an (edition, kind, subject) is the
 * narrative in force, and earlier rows stay as the record of what was drafted.
 * `sentences` keeps every sentence the model returned, including any the checker
 * held back (`finding` set), so an operator can see what was withheld and why.
 * `facts` is the exact fact list the model was given — the only thing a sentence
 * may rest on.
 *
 * Reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE report_narratives (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id  UUID        NOT NULL REFERENCES editions(id),
      kind        TEXT        NOT NULL CHECK (kind IN ('industry', 'firm')),
      subject_id  UUID        REFERENCES organizations(id),
      sentences   JSONB       NOT NULL,
      facts       JSONB       NOT NULL,
      model       TEXT        NOT NULL,
      created_by  TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((kind = 'firm') = (subject_id IS NOT NULL))
    )
  `);
  pgm.sql(`
    CREATE INDEX idx_report_narratives_latest
      ON report_narratives (edition_id, kind, subject_id, created_at DESC)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS report_narratives`);
};
