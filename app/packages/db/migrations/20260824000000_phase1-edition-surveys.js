'use strict';

/**
 * Phase 1 — Setup: Edition & Surveys.
 *
 * Adds:
 *  - instrument_definitions.scored        (instrument-level scoring gate)
 *  - instrument_questions                 (question-level, carries is_drg_ops)
 *  - edition_sample_floors                (per-category sufficiency floors)
 *
 * Design note on `scored` vs `is_drg_ops`:
 *  `scored` is an INSTRUMENT-level property (six survey instruments feed the
 *  indices; the three regulator instruments never do). `is_drg_ops` is a
 *  QUESTION-level property — seven operational questions are folded into the
 *  flow of six instruments. They therefore live on the questions table, where
 *  the "public-facing questions" query can be made structurally incapable of
 *  returning them.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── users.organization ───────────────────────────────────────────────────────
  // The organisation a user belongs to (e.g. 'CIS', 'Dragnet'). Recorded so that
  // both organisations are captured on every critical-action request/decision
  // (via the requested_by / approved_by / rejected_by FKs). The maker-checker
  // hard constraint remains a different PERSON, not a different organisation.
  pgm.sql(`ALTER TABLE users ADD COLUMN organization TEXT`);

  // ── instrument_definitions.scored ───────────────────────────────────────────
  // Default TRUE so the six survey instruments are scored by default; the three
  // regulator/contextual instruments are set FALSE explicitly at seed time.
  pgm.sql(`
    ALTER TABLE instrument_definitions
      ADD COLUMN scored BOOLEAN NOT NULL DEFAULT TRUE
  `);

  // ── instrument_questions ─────────────────────────────────────────────────────
  // Question-level content. In Phase 1 this holds illustrative/placeholder
  // content only (is_placeholder = TRUE); the controlled question bank comes
  // from the Survey Register in Phase 2.
  //
  // Invariant: a DRG-OPS question can NEVER be scored. Enforced by CHECK so no
  // service path can create a scored operational question.
  pgm.sql(`
    CREATE TABLE instrument_questions (
      id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_definition_id UUID        NOT NULL REFERENCES instrument_definitions(id)
                                             ON DELETE CASCADE,
      question_code            TEXT        NOT NULL UNIQUE,
      prompt_text              TEXT        NOT NULL,
      question_type            TEXT        NOT NULL DEFAULT 'single_choice'
                                           CHECK (question_type IN
                                             ('scale','single_choice','rank','open_text')),
      display_order            INTEGER     NOT NULL DEFAULT 0,
      scored                   BOOLEAN     NOT NULL DEFAULT TRUE,
      is_drg_ops               BOOLEAN     NOT NULL DEFAULT FALSE,
      is_placeholder           BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT drg_ops_never_scored
        CHECK (is_drg_ops = FALSE OR scored = FALSE)
    )
  `);

  pgm.sql(
    `CREATE INDEX idx_instrument_questions_def ON instrument_questions(instrument_definition_id)`,
  );
  // Partial index backing the public-question query's hardcoded exclusion.
  pgm.sql(
    `CREATE INDEX idx_instrument_questions_public
       ON instrument_questions(instrument_definition_id)
       WHERE is_drg_ops = FALSE`,
  );

  // ── edition_sample_floors ────────────────────────────────────────────────────
  // One row per respondent category per edition. Integer floor. Editability
  // (draft-only) is enforced at the service layer and audited on every change.
  pgm.sql(`
    CREATE TABLE edition_sample_floors (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id  UUID        NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
      category    TEXT        NOT NULL
                              CHECK (category IN
                                ('firm','retail','local_institution','foreign_institution')),
      floor_value INTEGER     NOT NULL CHECK (floor_value >= 1),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (edition_id, category)
    )
  `);

  pgm.sql(`CREATE INDEX idx_edition_sample_floors_edition ON edition_sample_floors(edition_id)`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS edition_sample_floors`);
  pgm.sql(`DROP TABLE IF EXISTS instrument_questions`);
  pgm.sql(`ALTER TABLE instrument_definitions DROP COLUMN IF EXISTS scored`);
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS organization`);
};
