'use strict';

/**
 * BUG-20 / BUG-03 (27 Oct fix list): a firm report's AI narrative gets the
 * same decision step as the national report before it can be released.
 *
 * The checker's findings already live on each drafted sentence
 * (`report_narratives.sentences[i].finding`). This table holds a person's
 * decision on one of them: SUPPRESS_CLAIM (agree, the sentence stays out) or
 * REJECT_WITH_REASON (the checker was wrong; the sentence is shown, and the
 * reason is kept). Keyed by the narrative and the sentence's place in it, so a
 * redraft — a new narrative — starts a fresh review: a decision is never
 * carried over to different words. One decision per finding, permanent.
 *
 * Reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE firm_narrative_decisions (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      narrative_id    UUID        NOT NULL REFERENCES report_narratives(id),
      narrative_index INTEGER     NOT NULL CHECK (narrative_index >= 0),
      disposition     TEXT        NOT NULL
                                  CHECK (disposition IN ('SUPPRESS_CLAIM', 'REJECT_WITH_REASON')),
      reason          TEXT,
      decided_by      TEXT        NOT NULL,
      decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (narrative_id, narrative_index),
      CHECK (disposition <> 'REJECT_WITH_REASON' OR length(trim(coalesce(reason, ''))) > 0)
    )
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_firm_narrative_decision_change()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'firm_narrative_decision % is permanent: % is not permitted', OLD.id, TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `);
  pgm.sql(`
    CREATE TRIGGER firm_narrative_decisions_no_change
      BEFORE UPDATE OR DELETE ON firm_narrative_decisions
      FOR EACH ROW EXECUTE FUNCTION prevent_firm_narrative_decision_change()
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS firm_narrative_decisions`);
  pgm.sql(`DROP FUNCTION IF EXISTS prevent_firm_narrative_decision_change()`);
};
