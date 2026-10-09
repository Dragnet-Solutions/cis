'use strict';

/**
 * Phase 4 — Firm claim, portal, team & outreach (UX-FRM-001).
 *
 * Builds on Phases 0–3. Structural boundaries the brief requires are enforced
 * in the schema itself:
 *  - firm_claims: one row per firm. A UNIQUE(organization_id) makes "one firm,
 *    one space" a database invariant — a second claimant cannot create a
 *    duplicate; they are redirected to the first (who claimed it first is never
 *    disclosed, enforced at the query layer).
 *  - seat_assignments: three seats (S1/S2/S3) per firm per edition, each with a
 *    state (empty/invited/started/complete). The row links to a respondent for
 *    completion tracking but carries NO answer content — a seat query returns
 *    state only, never what was answered (the Phase 3 visibility boundary,
 *    reused here).
 *  - outreach_links (from Phase 3) gains a segment and a finishes counter, so a
 *    firm sees per-segment opens/starts/finishes — VOLUMES ONLY. There is still
 *    no respondent/response key on this table, so no firm-facing query can
 *    correlate a response to an outreach link, and there is deliberately no
 *    "invitations sent" column: the platform never receives a client list and
 *    cannot observe an invitation count.
 *
 * Reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── firm_claims ──────────────────────────────────────────────────────────────
  // One space per firm. The claiming contact is recorded (shown masked, and not
  // editable from this surface — redirect to UX-OPS-002, out of scope). Follow-up
  // consent is per firm and gates nothing; privacy consent gated the claim action.
  pgm.sql(`
    CREATE TABLE firm_claims (
      id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id        UUID        NOT NULL UNIQUE REFERENCES organizations(id),
      claimed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claiming_contact_name  TEXT        NOT NULL,
      claiming_contact_email TEXT        NOT NULL,
      lead_coordinator_id    UUID        REFERENCES firm_coordinators(id),
      privacy_consent        BOOLEAN     NOT NULL DEFAULT FALSE,
      follow_up_consent      BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── seat_assignments ─────────────────────────────────────────────────────────
  // Three firm surveys per firm per edition. seat_code is the instrument (S1/S2/
  // S3); role_label is the human role that owns it (MD/Compliance/Operations).
  // respondent_id links to the response record for STATE tracking only — there is
  // no path from here to answer content.
  pgm.sql(`
    CREATE TABLE seat_assignments (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id      UUID        NOT NULL REFERENCES editions(id),
      organization_id UUID        NOT NULL REFERENCES organizations(id),
      seat_code       TEXT        NOT NULL CHECK (seat_code IN ('S1','S2','S3')),
      role_label      TEXT        NOT NULL,
      assigned_name   TEXT,
      assigned_email  TEXT,
      state           TEXT        NOT NULL DEFAULT 'empty'
                                  CHECK (state IN ('empty','invited','started','complete')),
      is_self         BOOLEAN     NOT NULL DEFAULT FALSE,
      stalled_at      TEXT,
      respondent_id   UUID        REFERENCES respondents(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (edition_id, organization_id, seat_code)
    )
  `);
  pgm.sql(
    `CREATE INDEX idx_seat_assignments_firm ON seat_assignments(edition_id, organization_id)`,
  );
  // The same address may not hold two seats in one firm/edition.
  pgm.sql(`
    CREATE UNIQUE INDEX uniq_seat_email_per_firm
      ON seat_assignments(edition_id, organization_id, lower(assigned_email))
      WHERE assigned_email IS NOT NULL
  `);

  // ── outreach_links: firm-level segments + finishes ───────────────────────────
  // Extend the Phase 3 counters-only table. A segment identifies which audience
  // the link addresses; finishes is the third volume alongside opens/starts.
  // Still NO respondent/response key — non-joinability is preserved.
  pgm.sql(`
    ALTER TABLE outreach_links
      ADD COLUMN segment  TEXT
                 CHECK (segment IN ('individual','local_institutional','foreign_institutional')),
      ADD COLUMN finishes INTEGER NOT NULL DEFAULT 0
  `);
  // At most one link per (edition, firm, segment).
  pgm.sql(`
    CREATE UNIQUE INDEX uniq_outreach_segment
      ON outreach_links(edition_id, organization_id, segment)
      WHERE segment IS NOT NULL
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP INDEX IF EXISTS uniq_outreach_segment`);
  pgm.sql(
    `ALTER TABLE outreach_links DROP COLUMN IF EXISTS segment, DROP COLUMN IF EXISTS finishes`,
  );
  pgm.sql(`DROP INDEX IF EXISTS uniq_seat_email_per_firm`);
  pgm.sql(`DROP INDEX IF EXISTS idx_seat_assignments_firm`);
  pgm.sql(`DROP TABLE IF EXISTS seat_assignments`);
  pgm.sql(`DROP TABLE IF EXISTS firm_claims`);
};
