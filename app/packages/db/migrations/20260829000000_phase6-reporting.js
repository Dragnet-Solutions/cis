'use strict';

/**
 * Phase 6 — AI reporting, review & publication (E08).
 *
 * Two surfaces with DIFFERENT guarantee semantics, deliberately not one pipeline:
 *  - national_reports: ONE national report, ten fixed sections, generator +
 *    adversarial sentence-level review + human disposition + approval.
 *  - firm_reports: 80+ individual firm reports, each independently sufficiency-
 *    gated on ONE section (the retail cut), released ATOMIC PER REPORT.
 *
 * Immutability: a RELEASED firm report is never edited or recalled — a
 * conditional trigger blocks UPDATE/DELETE once release_state = 'released'.
 * Corrections are a new version row. Release history is append-only.
 *
 * Reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── national_reports ─────────────────────────────────────────────────────────
  // One per (edition, signed scoring run). Approval requires four preconditions
  // (signed run, draft opened, all findings disposed, checker healthy) enforced
  // in the service; the row records the maker-checker approval (approver ≠ requester).
  pgm.sql(`
    CREATE TABLE national_reports (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id       UUID        NOT NULL REFERENCES editions(id),
      scoring_run_id   UUID        NOT NULL REFERENCES calculation_runs(id),
      status           TEXT        NOT NULL DEFAULT 'draft'
                                   CHECK (status IN ('draft','approved')),
      draft_opened     BOOLEAN     NOT NULL DEFAULT FALSE,
      requested_by     TEXT,
      requested_reason TEXT,
      requested_at     TIMESTAMPTZ,
      approved_by      TEXT,
      approved_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_national_reports_edition ON national_reports(edition_id)`);

  // ── national_report_sections ─────────────────────────────────────────────────
  // The ten sections, each by its EVIDENCE_PACK_CONTRACT id. A section is
  // publishable, caveated (thin but shown, §2), or suppressed (§7/§10). Closed
  // section-id set enforced by CHECK.
  pgm.sql(`
    CREATE TABLE national_report_sections (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      national_report_id UUID        NOT NULL REFERENCES national_reports(id) ON DELETE CASCADE,
      section_id         TEXT        NOT NULL CHECK (section_id IN
                           ('PUB_01_HEADLINE_INDICES','PUB_02_SEGMENT_IEI_ICI',
                            'PUB_03_OPERATIONAL_FRICTIONS','PUB_04_INVESTOR_FRUSTRATIONS',
                            'PUB_05_MATURITY_HEATMAP','PUB_06_CONFIDENCE_AND_PARTICIPATION',
                            'PUB_07_LOCAL_VS_FOREIGN','PUB_08_CROSS_INDUSTRY_BENCHMARK',
                            'PUB_09_SERVICE_EXCELLENCE_GAP','PUB_10_INSTITUTIONAL_PERSPECTIVES')),
      disposition        TEXT        NOT NULL CHECK (disposition IN ('publishable','caveated','suppressed')),
      reason             TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (national_report_id, section_id)
    )
  `);

  // ── national_report_sentences + findings + dispositions ──────────────────────
  // The draft is reviewed sentence by sentence. A sentence with no fact ids is
  // unsupported by definition. The checker flags; a human disposes of each
  // finding. A rejection requires a reason — enforced at the data layer.
  pgm.sql(`
    CREATE TABLE national_report_sentences (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      national_report_id UUID        NOT NULL REFERENCES national_reports(id) ON DELETE CASCADE,
      ordinal            INTEGER     NOT NULL,
      text               TEXT        NOT NULL,
      fact_ids           JSONB       NOT NULL DEFAULT '[]',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_nr_sentences_report ON national_report_sentences(national_report_id)`);

  pgm.sql(`
    CREATE TABLE national_report_findings (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      sentence_id  UUID        NOT NULL REFERENCES national_report_sentences(id) ON DELETE CASCADE,
      kind         TEXT        NOT NULL,
      why          TEXT        NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_nr_findings_sentence ON national_report_findings(sentence_id)`);

  pgm.sql(`
    CREATE TABLE national_report_dispositions (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      finding_id   UUID        NOT NULL UNIQUE REFERENCES national_report_findings(id) ON DELETE CASCADE,
      disposition  TEXT        NOT NULL CHECK (disposition IN ('ACCEPT_AND_EDIT','REJECT_WITH_REASON','SUPPRESS_CLAIM')),
      reason       TEXT,
      disposed_by  TEXT        NOT NULL,
      disposed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- A rejection requires a reason: a reviewer who dismisses every finding
      -- must leave a record of why, distinct from a run with no checker at all.
      CHECK (disposition <> 'REJECT_WITH_REASON' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
    )
  `);

  // ── adversary_health ─────────────────────────────────────────────────────────
  // Detection performance against a seeded set of known-unsupported claims.
  // A clean draft and a broken checker look identical, so this gates approval.
  pgm.sql(`
    CREATE TABLE adversary_health (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      national_report_id UUID        NOT NULL REFERENCES national_reports(id) ON DELETE CASCADE,
      seeded_total       INTEGER     NOT NULL,
      detected           INTEGER     NOT NULL,
      threshold_rate     NUMERIC     NOT NULL,
      healthy            BOOLEAN     NOT NULL,
      checked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_adversary_health_report ON adversary_health(national_report_id)`);

  // ── firm_reports ─────────────────────────────────────────────────────────────
  // One per participating firm per edition per version. FRM_01/02/03 are
  // guaranteed (never suppressed); only the retail cut (FRM_04) is gated. Release
  // is atomic per report; a failed/unresolved report is HELD, not excluded.
  pgm.sql(`
    CREATE TABLE firm_reports (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id       UUID        NOT NULL REFERENCES editions(id),
      organization_id  UUID        NOT NULL REFERENCES organizations(id),
      scoring_run_id   UUID        NOT NULL REFERENCES calculation_runs(id),
      version          INTEGER     NOT NULL DEFAULT 1,
      retail_n         INTEGER     NOT NULL DEFAULT 0,
      cut_state        TEXT        NOT NULL DEFAULT 'none'
                                   CHECK (cut_state IN ('none','directional','unlocked')),
      generation_state TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (generation_state IN ('pending','generating','generated','failed')),
      approval_state   TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (approval_state IN ('pending','approved')),
      release_state    TEXT        NOT NULL DEFAULT 'unreleased'
                                   CHECK (release_state IN ('unreleased','held','released')),
      held_reason      TEXT,
      released_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (edition_id, organization_id, version)
    )
  `);
  pgm.sql(`CREATE INDEX idx_firm_reports_edition ON firm_reports(edition_id)`);

  // A RELEASED report is immutable — never edited, never recalled. A correction
  // is a new version row, not an edit to the released one.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_released_firm_report_change()
    RETURNS TRIGGER AS $$
    BEGIN
      IF (OLD.release_state = 'released') THEN
        RAISE EXCEPTION 'firm_report % is released and immutable: % is not permitted', OLD.id, TG_OP;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  pgm.sql(`
    CREATE TRIGGER firm_reports_released_no_update
      BEFORE UPDATE ON firm_reports
      FOR EACH ROW EXECUTE FUNCTION prevent_released_firm_report_change()
  `);
  pgm.sql(`
    CREATE TRIGGER firm_reports_released_no_delete
      BEFORE DELETE ON firm_reports
      FOR EACH ROW EXECUTE FUNCTION prevent_released_firm_report_change()
  `);

  // ── firm_report_release_history (append-only) ────────────────────────────────
  // A permanent, per-report record: which released, which were held, and why.
  pgm.sql(`
    CREATE TABLE firm_report_release_history (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      firm_report_id   UUID        NOT NULL REFERENCES firm_reports(id),
      edition_id       UUID        NOT NULL REFERENCES editions(id),
      organization_id  UUID        NOT NULL REFERENCES organizations(id),
      action           TEXT        NOT NULL CHECK (action IN ('released','held','regenerated')),
      reason           TEXT,
      occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_frrh_edition ON firm_report_release_history(edition_id)`);
  pgm.sql(`
    CREATE TRIGGER frrh_no_update BEFORE UPDATE ON firm_report_release_history
      FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()
  `);
  pgm.sql(`
    CREATE TRIGGER frrh_no_delete BEFORE DELETE ON firm_report_release_history
      FOR EACH ROW EXECUTE FUNCTION prevent_row_modification()
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS firm_report_release_history`);
  pgm.sql(`DROP TABLE IF EXISTS firm_reports`);
  pgm.sql(`DROP FUNCTION IF EXISTS prevent_released_firm_report_change()`);
  pgm.sql(`DROP TABLE IF EXISTS adversary_health`);
  pgm.sql(`DROP TABLE IF EXISTS national_report_dispositions`);
  pgm.sql(`DROP TABLE IF EXISTS national_report_findings`);
  pgm.sql(`DROP TABLE IF EXISTS national_report_sentences`);
  pgm.sql(`DROP TABLE IF EXISTS national_report_sections`);
  pgm.sql(`DROP TABLE IF EXISTS national_reports`);
};
