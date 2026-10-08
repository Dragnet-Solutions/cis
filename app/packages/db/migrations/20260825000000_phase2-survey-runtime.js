'use strict';

/**
 * Phase 2 — Survey runtime & content authority.
 *
 * Extends instrument_questions with the full Register field set, and adds the
 * respondents + responses tables. Response content (the 90 items) is loaded by
 * the parameterized seed loader `seedSurveyRegister` (packages/db/src/seed/…),
 * NOT by raw SQL here — the platform rule is "parameterized queries only, zero
 * string-concatenated SQL anywhere, including migrations". This migration is
 * schema only; it is reversible.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── instrument_questions: full Register field set ────────────────────────────
  // Phase 1 shipped a restrictive `question_type` (4 values). The Register uses
  // eight kinds — rename the column to `kind` and widen the CHECK.
  pgm.sql(`ALTER TABLE instrument_questions RENAME COLUMN question_type TO kind`);
  pgm.sql(
    `ALTER TABLE instrument_questions DROP CONSTRAINT instrument_questions_question_type_check`,
  );
  pgm.sql(`ALTER TABLE instrument_questions ALTER COLUMN kind DROP DEFAULT`);
  pgm.sql(`
    ALTER TABLE instrument_questions
      ADD CONSTRAINT instrument_questions_kind_check
      CHECK (kind IN ('scale','single','yesno','select','multi','rank','grid','open'))
  `);

  pgm.sql(`
    ALTER TABLE instrument_questions
      ADD COLUMN scope                 TEXT    NOT NULL DEFAULT 'shared'
                                       CHECK (scope IN ('shared','firm_specific')),
      ADD COLUMN options               JSONB,
      ADD COLUMN scale_min             INTEGER,
      ADD COLUMN scale_max             INTEGER,
      ADD COLUMN scale_anchors         TEXT,
      ADD COLUMN rank_exactly_n        INTEGER,
      ADD COLUMN select_up_to_n        INTEGER,
      ADD COLUMN has_optional_comment  BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN answer_optional       BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN conditional_detail_on TEXT,
      ADD COLUMN select_then_greatest  BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN grid_rows             JSONB,
      ADD COLUMN grid_dimensions       JSONB,
      ADD COLUMN grid_scale            JSONB
  `);

  pgm.sql(`CREATE INDEX idx_instrument_questions_scope ON instrument_questions(scope)`);

  // ── respondents ──────────────────────────────────────────────────────────────
  // A respondent answers one instrument in one edition. The recruiting/source
  // firm (how they arrived) is recorded here and is DISTINCT from the firms they
  // rate. Arrival via a firm must never make that firm a rated firm (SV-010 §3).
  pgm.sql(`
    CREATE TABLE respondents (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id         UUID        NOT NULL REFERENCES editions(id),
      instrument_code    TEXT        NOT NULL,
      recruiting_firm_id UUID        REFERENCES organizations(id),
      submitted_at       TIMESTAMPTZ,
      consent_accepted   BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_respondents_edition ON respondents(edition_id)`);
  pgm.sql(`CREATE INDEX idx_respondents_recruiting_firm ON respondents(recruiting_firm_id)`);

  // ── responses ────────────────────────────────────────────────────────────────
  // Raw, immutable answer record. One row per respondent per question — and per
  // rated firm for firm-specific items. question_id is the Register ID, stored
  // verbatim and never dropped. rated_firm_id is a DIFFERENT foreign key from
  // the respondent's recruiting_firm_id — the separation is enforced by the
  // schema, not just convention. answer is the canonical {a, c} envelope.
  pgm.sql(`
    CREATE TABLE responses (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id    UUID        NOT NULL REFERENCES editions(id),
      respondent_id UUID        NOT NULL REFERENCES respondents(id),
      question_id   TEXT        NOT NULL,
      scope         TEXT        NOT NULL CHECK (scope IN ('shared','firm_specific')),
      rated_firm_id UUID        REFERENCES organizations(id),
      answer        JSONB       NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- A shared item has no rated firm; a firm-specific item must have one.
      CONSTRAINT response_scope_firm_consistency CHECK (
        (scope = 'shared' AND rated_firm_id IS NULL) OR
        (scope = 'firm_specific' AND rated_firm_id IS NOT NULL)
      ),
      -- No duplicate answer for the same (respondent, question, rated firm).
      -- NULLS NOT DISTINCT so a shared item (null firm) is unique per question.
      UNIQUE NULLS NOT DISTINCT (respondent_id, question_id, rated_firm_id)
    )
  `);
  pgm.sql(`CREATE INDEX idx_responses_edition ON responses(edition_id)`);
  pgm.sql(`CREATE INDEX idx_responses_respondent ON responses(respondent_id)`);
  pgm.sql(`CREATE INDEX idx_responses_question ON responses(question_id)`);
  pgm.sql(`CREATE INDEX idx_responses_rated_firm ON responses(rated_firm_id)`);

  // Immutability: responses are append-only (Phase 0 principle — no overwrites).
  // UPDATE and DELETE are blocked at the DB level; TRUNCATE stays allowed for
  // test teardown.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_response_modification()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'responses are immutable: % operations are not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `);
  pgm.sql(`
    CREATE TRIGGER responses_no_update
      BEFORE UPDATE ON responses
      FOR EACH ROW EXECUTE FUNCTION prevent_response_modification()
  `);
  pgm.sql(`
    CREATE TRIGGER responses_no_delete
      BEFORE DELETE ON responses
      FOR EACH ROW EXECUTE FUNCTION prevent_response_modification()
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TRIGGER IF EXISTS responses_no_delete ON responses`);
  pgm.sql(`DROP TRIGGER IF EXISTS responses_no_update ON responses`);
  pgm.sql(`DROP FUNCTION IF EXISTS prevent_response_modification()`);
  pgm.sql(`DROP TABLE IF EXISTS responses`);
  pgm.sql(`DROP TABLE IF EXISTS respondents`);

  pgm.sql(`DROP INDEX IF EXISTS idx_instrument_questions_scope`);
  pgm.sql(`
    ALTER TABLE instrument_questions
      DROP COLUMN IF EXISTS scope,
      DROP COLUMN IF EXISTS options,
      DROP COLUMN IF EXISTS scale_min,
      DROP COLUMN IF EXISTS scale_max,
      DROP COLUMN IF EXISTS scale_anchors,
      DROP COLUMN IF EXISTS rank_exactly_n,
      DROP COLUMN IF EXISTS select_up_to_n,
      DROP COLUMN IF EXISTS has_optional_comment,
      DROP COLUMN IF EXISTS answer_optional,
      DROP COLUMN IF EXISTS conditional_detail_on,
      DROP COLUMN IF EXISTS select_then_greatest,
      DROP COLUMN IF EXISTS grid_rows,
      DROP COLUMN IF EXISTS grid_dimensions,
      DROP COLUMN IF EXISTS grid_scale
  `);
  pgm.sql(`ALTER TABLE instrument_questions DROP CONSTRAINT instrument_questions_kind_check`);
  pgm.sql(`ALTER TABLE instrument_questions ALTER COLUMN kind SET DEFAULT 'single_choice'`);
  pgm.sql(`ALTER TABLE instrument_questions RENAME COLUMN kind TO question_type`);
  pgm.sql(`
    ALTER TABLE instrument_questions
      ADD CONSTRAINT instrument_questions_question_type_check
      CHECK (question_type IN ('scale','single_choice','rank','open_text'))
  `);
};
