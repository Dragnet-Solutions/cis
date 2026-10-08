'use strict';

/**
 * Phase 10 — Study Operations Home & Mission Board (UX-OPS-001).
 *
 * The board answers one question — "what needs a person today" — ranked by
 * consequence, forecast-based rather than raw-count-based. Almost everything it
 * needs already exists: `funnel_event` (Phase 5) is the spine, `report_dependency`
 * (Phase 5) the sufficiency map, and Phase 4/5 supply firm/seat/attribution
 * state. `segment_state` and `firm_state` are computed FRESH each hourly cycle
 * (never stored as mutable running totals), so this migration adds only the one
 * genuinely persistent new structure:
 *
 *   `institution_engagement` — one row per regulator (SEC/NGX/CSCS) with a
 *   status model and a `target_by` date. Condition 16 fires only once an
 *   institution is late against its OWN lead time — never a binary "not engaged"
 *   check that is red from day one. `target_by` is a DECISION-NEEDED item
 *   (study-team dates, not computed): seeded structurally as NULL, and condition
 *   16 does not evaluate for an institution whose `target_by` is unset.
 *
 * Reversible. Schema only; the row-per-institution seed and the report_dependency
 * reconciliation are parameterized loaders.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE institution_engagement (
      id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id        UUID        NOT NULL REFERENCES editions(id),
      institution       TEXT        NOT NULL CHECK (institution IN ('SEC','NGX','CSCS')),
      status            TEXT        NOT NULL DEFAULT 'not_started'
                                    CHECK (status IN ('not_started','invited','in_progress','confirmed','declined')),
      status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- DECISION NEEDED: study-team-set lead-time date, NOT computed. NULL until
      -- entered; condition 16 does not evaluate while it is NULL.
      target_by         DATE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (edition_id, institution)
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS institution_engagement`);
};
