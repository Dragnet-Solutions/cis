'use strict';

/**
 * Phase 3 — Respondent & firm journey surfaces.
 *
 * Adds the tables and columns the journey surfaces need, with the structural
 * access-control boundaries the brief requires enforced in the schema itself:
 *  - firm_coordinators: firm account/team (lead handover, PINs, access codes).
 *  - outreach_links: outreach tracking with COUNTERS ONLY — no respondent or
 *    response reference exists, so no firm-facing query can ever correlate a
 *    specific response to a specific outreach link.
 *  - governed_config: swappable governed content/parameters (consent copy,
 *    recovery-link TTL, results-section visibility) — seeded as data, not code.
 *  - respondents gains journey/resume state (rated firm list + step), a
 *    respondent-to-respondent referral link (never a firm), and institution
 *    name for institutional grouping.
 *
 * Reversible. Schema only; governed content is loaded by a parameterized seed.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── respondents: journey / resume / referral / institution / contact ─────────
  // Contact + delivery live on the respondent (mutable), kept structurally
  // separate from the immutable `responses` table — changing report delivery
  // never touches a submitted answer.
  pgm.sql(`
    ALTER TABLE respondents
      ADD COLUMN rated_firm_ids            JSONB   NOT NULL DEFAULT '[]',
      ADD COLUMN resume_step               INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN referred_by_respondent_id UUID    REFERENCES respondents(id),
      ADD COLUMN institution_name          TEXT,
      ADD COLUMN contact_channel           TEXT
                                           CHECK (contact_channel IN ('email','text','both','none')),
      ADD COLUMN contact_email             TEXT,
      ADD COLUMN contact_phone             TEXT,
      ADD COLUMN recovery_token            TEXT UNIQUE,
      ADD COLUMN report_delivery           TEXT
  `);

  // ── respondent_drafts ────────────────────────────────────────────────────────
  // Mutable in-progress answers (autosave, no save control). Distinct from the
  // immutable `responses` record: on submit, drafts are frozen into responses.
  // A change before submit updates the draft; the final record is written once.
  pgm.sql(`
    CREATE TABLE respondent_drafts (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      respondent_id UUID        NOT NULL REFERENCES respondents(id) ON DELETE CASCADE,
      question_id   TEXT        NOT NULL,
      scope         TEXT        NOT NULL CHECK (scope IN ('shared','firm_specific')),
      rated_firm_id UUID        REFERENCES organizations(id),
      answer        JSONB       NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE NULLS NOT DISTINCT (respondent_id, question_id, rated_firm_id)
    )
  `);
  pgm.sql(`CREATE INDEX idx_respondent_drafts_respondent ON respondent_drafts(respondent_id)`);

  // ── firm_coordinators ─────────────────────────────────────────────────────────
  // Ordinary account administration (NOT maker-checker). One active lead per firm.
  pgm.sql(`
    CREATE TABLE firm_coordinators (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID        NOT NULL REFERENCES organizations(id),
      name            TEXT        NOT NULL,
      role            TEXT,
      email           TEXT        NOT NULL,
      phone           TEXT,
      is_lead         BOOLEAN     NOT NULL DEFAULT FALSE,
      pin_hash        TEXT,
      access_code     TEXT        NOT NULL,
      revoked_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // One active coordinator per email per firm.
  pgm.sql(`
    CREATE UNIQUE INDEX uniq_active_coordinator_email
      ON firm_coordinators(organization_id, email)
      WHERE revoked_at IS NULL
  `);
  // At most one active lead per firm.
  pgm.sql(`
    CREATE UNIQUE INDEX uniq_active_lead_per_firm
      ON firm_coordinators(organization_id)
      WHERE is_lead = TRUE AND revoked_at IS NULL
  `);
  pgm.sql(`CREATE INDEX idx_firm_coordinators_org ON firm_coordinators(organization_id)`);

  // ── outreach_links ─────────────────────────────────────────────────────────────
  // Counters only. Deliberately NO respondent_id / response_id column: outreach
  // tracking is structurally separate from response records, so a firm can see
  // its own opens/starts but can never determine which response came from its
  // link. Do not add a joinable key here.
  pgm.sql(`
    CREATE TABLE outreach_links (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id      UUID        NOT NULL REFERENCES editions(id),
      organization_id UUID        NOT NULL REFERENCES organizations(id),
      token           TEXT        NOT NULL UNIQUE,
      opens           INTEGER     NOT NULL DEFAULT 0,
      starts          INTEGER     NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_outreach_links_org ON outreach_links(edition_id, organization_id)`);

  // ── governed_config ──────────────────────────────────────────────────────────
  // Swappable governed content/parameters. Consent copy is legally provisional
  // (OPEN-003) and the recovery-link TTL is operational — neither is hardcoded.
  pgm.sql(`
    CREATE TABLE governed_config (
      key         TEXT        PRIMARY KEY,
      value       JSONB       NOT NULL,
      description TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS governed_config`);
  pgm.sql(`DROP TABLE IF EXISTS outreach_links`);
  pgm.sql(`DROP INDEX IF EXISTS idx_firm_coordinators_org`);
  pgm.sql(`DROP INDEX IF EXISTS uniq_active_lead_per_firm`);
  pgm.sql(`DROP INDEX IF EXISTS uniq_active_coordinator_email`);
  pgm.sql(`DROP TABLE IF EXISTS firm_coordinators`);
  pgm.sql(`DROP TABLE IF EXISTS respondent_drafts`);
  pgm.sql(`
    ALTER TABLE respondents
      DROP COLUMN IF EXISTS rated_firm_ids,
      DROP COLUMN IF EXISTS resume_step,
      DROP COLUMN IF EXISTS referred_by_respondent_id,
      DROP COLUMN IF EXISTS institution_name,
      DROP COLUMN IF EXISTS contact_channel,
      DROP COLUMN IF EXISTS contact_email,
      DROP COLUMN IF EXISTS contact_phone,
      DROP COLUMN IF EXISTS recovery_token,
      DROP COLUMN IF EXISTS report_delivery
  `);
};
