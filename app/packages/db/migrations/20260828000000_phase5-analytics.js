'use strict';

/**
 * Phase 5 — Scoring, sufficiency, analytics & evidence (E07).
 *
 * A versioned, reproducible calculation framework. The actual OMI/DMI/IEI/ICI/
 * SEI weighting is NOT settled in the controlled estate, so this migration
 * builds the framework that will run whatever methodology gets approved — never
 * a hardcoded formula. Configuration lives in `metric_definitions` (data), runs
 * are immutable, and corrections create new runs rather than editing results.
 *
 * Immutable (append-only) tables: funnel_event, calculation_runs,
 * calculated_results, eligibility_results, evidence_packs, evidence_pack_facts.
 * Mutable config: metric_definitions (versioned rows) and report_dependency
 * (study-team editable without a deploy).
 *
 * Reversible. Schema only; provisional metric configuration is seeded by a
 * parameterized loader, not embedded here.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // A reusable append-only guard (same discipline as audit_log / responses).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_row_modification()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION '% is immutable: % operations are not permitted', TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `);
  const immutable = (table) => {
    pgm.sql(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
             FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()`);
    pgm.sql(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
             FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()`);
  };

  // ── funnel_event ─────────────────────────────────────────────────────────────
  // The event stream (OPS_RESPONSES_CALCULATION_BRIEF §2). Append-only. A
  // `completed` event fires from the SAME transaction that finalizes a response,
  // so the two can never drift. One completed event per response regardless of
  // how many firms were rated. firm_id is the register identifier, never a name;
  // institution_ref is an opaque token — no institution name is ever collected.
  pgm.sql(`
    CREATE TABLE funnel_event (
      event_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type     TEXT        NOT NULL CHECK (event_type IN ('invited','opened','started','completed')),
      occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      edition_id     UUID        NOT NULL REFERENCES editions(id),
      segment        TEXT        NOT NULL CHECK (segment IN ('retail','local_institution','foreign_institution','firm')),
      firm_id        UUID        REFERENCES organizations(id),
      institution_ref TEXT,
      channel        TEXT        NOT NULL CHECK (channel IN ('email','sms','qr','portal','direct')),
      source         TEXT        NOT NULL CHECK (source IN ('invitation','colleague_share','participant_referral','direct')),
      response_id    UUID        REFERENCES respondents(id)
    )
  `);
  pgm.sql(`CREATE INDEX idx_funnel_event_edition ON funnel_event(edition_id, event_type)`);
  pgm.sql(`CREATE INDEX idx_funnel_event_segment ON funnel_event(edition_id, segment, event_type)`);
  // One completed event per response — a response is a single respondent
  // submission, however many firms it rated.
  pgm.sql(`
    CREATE UNIQUE INDEX uniq_completed_per_response
      ON funnel_event(response_id)
      WHERE event_type = 'completed' AND response_id IS NOT NULL
  `);
  immutable('funnel_event');

  // ── metric_definitions ───────────────────────────────────────────────────────
  // Versioned CONFIGURATION for each index (OMI/DMI/IEI/ICI/SEI) and sub-
  // components: which question IDs feed the index and what aggregation/weighting
  // rule applies. NOT a formula in code. Seeded with a provisional equal-weight
  // placeholder (flagged) until Dragnet's methodology is validated. New version =
  // new row; a version is never edited in place.
  pgm.sql(`
    CREATE TABLE metric_definitions (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      metric_code    TEXT        NOT NULL,
      version        INTEGER     NOT NULL,
      config         JSONB       NOT NULL,
      is_provisional BOOLEAN     NOT NULL DEFAULT TRUE,
      is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
      description    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (metric_code, version)
    )
  `);

  // ── calculation_runs ─────────────────────────────────────────────────────────
  // Immutable run record. Two methodology versions can run against the same
  // frozen dataset (same dataset_hash) and both are retained (AT-02).
  pgm.sql(`
    CREATE TABLE calculation_runs (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id         UUID        NOT NULL REFERENCES editions(id),
      run_type           TEXT        NOT NULL CHECK (run_type IN ('eligibility','scoring')),
      methodology_version TEXT,
      dataset_hash       TEXT        NOT NULL,
      status             TEXT        NOT NULL DEFAULT 'complete'
                                     CHECK (status IN ('pending','running','complete','failed')),
      started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_calculation_runs_edition ON calculation_runs(edition_id, run_type)`);
  immutable('calculation_runs');

  // ── eligibility_results ──────────────────────────────────────────────────────
  // Eligibility runs SEPARATELY from scoring and is persisted before any scoring
  // touches response data. Per-firm and per-segment.
  pgm.sql(`
    CREATE TABLE eligibility_results (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      calculation_run_id UUID        NOT NULL REFERENCES calculation_runs(id),
      subject_type       TEXT        NOT NULL CHECK (subject_type IN ('firm','segment')),
      subject_id         TEXT        NOT NULL,
      segment            TEXT,
      counted            INTEGER     NOT NULL,
      floor              INTEGER     NOT NULL,
      eligible           BOOLEAN     NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_eligibility_results_run ON eligibility_results(calculation_run_id)`);
  immutable('eligibility_results');

  // ── calculated_results ───────────────────────────────────────────────────────
  // Immutable results. A correction is a NEW run, never an edit. A SUPPRESSED
  // result stores its state and reason but never the underlying value. A BANDED
  // result carries a band, never a point value (enforced by CHECK + write path).
  pgm.sql(`
    CREATE TABLE calculated_results (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      calculation_run_id UUID        NOT NULL REFERENCES calculation_runs(id),
      subject_type       TEXT        NOT NULL CHECK (subject_type IN ('firm','segment','market')),
      subject_id         TEXT        NOT NULL,
      metric_code        TEXT        NOT NULL,
      value              NUMERIC,
      band               TEXT,
      n                  INTEGER     NOT NULL DEFAULT 0,
      denominator        INTEGER     NOT NULL DEFAULT 0,
      sufficiency_state  TEXT        NOT NULL
                                     CHECK (sufficiency_state IN ('REPORTABLE','DIRECTIONAL','BANDED','SUPPRESSED')),
      reason             TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- A BANDED result must not carry a point value; a SUPPRESSED result must
      -- carry neither value nor band. Structural, not just enforced in code.
      CHECK (sufficiency_state <> 'BANDED' OR value IS NULL),
      CHECK (sufficiency_state <> 'SUPPRESSED' OR (value IS NULL AND band IS NULL))
    )
  `);
  pgm.sql(`CREATE INDEX idx_calculated_results_run ON calculated_results(calculation_run_id)`);
  pgm.sql(
    `CREATE INDEX idx_calculated_results_subject ON calculated_results(subject_type, subject_id)`,
  );
  immutable('calculated_results');

  // ── report_dependency (mutable config) ───────────────────────────────────────
  // Runtime configuration the study team edits without a deploy: which segments a
  // report output depends on, and the sufficiency rule over their state.
  pgm.sql(`
    CREATE TABLE report_dependency (
      output_id       TEXT        PRIMARY KEY,
      depends_on      JSONB       NOT NULL DEFAULT '[]',
      sufficiency_rule TEXT       NOT NULL,
      enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── evidence_packs + evidence_pack_facts ─────────────────────────────────────
  // The reporting-facing boundary. Immutable. Report sections are a closed set
  // (PUB_01..PUB_10 / FRM_01..FRM_04). Every fact carries a source chain back to
  // calculated_results (traceability). Construction-time validations (DRG-OPS
  // exclusion, BANDED-no-value, guaranteed-section-never-suppressed, no
  // institutional-as-index-input, no cross-firm leak) live in the domain builder.
  pgm.sql(`
    CREATE TABLE evidence_packs (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      calculation_run_id UUID        NOT NULL REFERENCES calculation_runs(id),
      report_type        TEXT        NOT NULL CHECK (report_type IN ('PUBLIC_REPORT','FIRM_REPORT')),
      subject_type       TEXT        NOT NULL CHECK (subject_type IN ('firm','market')),
      subject_id         TEXT        NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  immutable('evidence_packs');

  pgm.sql(`
    CREATE TABLE evidence_pack_facts (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      pack_id            UUID        NOT NULL REFERENCES evidence_packs(id) ON DELETE CASCADE,
      section_id         TEXT        NOT NULL CHECK (section_id IN
                           ('PUB_01','PUB_02','PUB_03','PUB_04','PUB_05','PUB_06','PUB_07','PUB_08','PUB_09','PUB_10',
                            'FRM_01','FRM_02','FRM_03','FRM_04')),
      metric_code        TEXT,
      sufficiency_state  TEXT        NOT NULL
                                     CHECK (sufficiency_state IN ('REPORTABLE','DIRECTIONAL','BANDED','SUPPRESSED')),
      value              NUMERIC,
      band               TEXT,
      source_result_id   UUID        REFERENCES calculated_results(id),
      source_question_ids JSONB      NOT NULL DEFAULT '[]',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (sufficiency_state <> 'BANDED' OR value IS NULL),
      CHECK (sufficiency_state <> 'SUPPRESSED' OR (value IS NULL AND band IS NULL))
    )
  `);
  pgm.sql(`CREATE INDEX idx_evidence_pack_facts_pack ON evidence_pack_facts(pack_id)`);
  // ON DELETE CASCADE above is for schema teardown symmetry only — the immutability
  // trigger blocks row DELETE, so facts are never removed in normal operation.
  immutable('evidence_pack_facts');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS evidence_pack_facts`);
  pgm.sql(`DROP TABLE IF EXISTS evidence_packs`);
  pgm.sql(`DROP TABLE IF EXISTS report_dependency`);
  pgm.sql(`DROP TABLE IF EXISTS calculated_results`);
  pgm.sql(`DROP TABLE IF EXISTS eligibility_results`);
  pgm.sql(`DROP TABLE IF EXISTS calculation_runs`);
  pgm.sql(`DROP TABLE IF EXISTS metric_definitions`);
  pgm.sql(`DROP TABLE IF EXISTS funnel_event`);
  pgm.sql(`DROP FUNCTION IF EXISTS prevent_row_modification()`);
};
