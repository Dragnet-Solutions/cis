'use strict';

/**
 * Phase 9 — Study Operations: Invitations (UX-OPS-002).
 *
 * The operator surface that writes to firms, regulators and consented
 * participants. Almost every audience is a QUERY against state the platform
 * already holds (Phase 3 contact-consent, Phase 4 firm-claim / seat-assignment /
 * outreach), so this migration adds only the messaging estate itself, plus a
 * provisional regulator-contact stub and the persistence for Phase 4's
 * request-an-invitation submissions (whose operational other half lives here).
 *
 * Mutable by design: delivery/bounce/open/click state arrives AFTER a send and
 * updates these rows, and a request is resolved in place — so no immutability
 * triggers here (same posture as report_dependency).
 *
 * Deliberately NOT built (see README open items): register/near-match resolution
 * (removed in the artefact's own v3.16); any resend-to-bounced action; a
 * hardcoded sending provider; wiring markOpened() to a send.
 *
 * Reversible. Schema only; templates and regulator contacts are seeded by
 * parameterized loaders.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // ── message_templates ────────────────────────────────────────────────────────
  // One per firm-state transition (six seeded) plus operator-authored ones.
  // `requires_code` marks a template that carries a firm invitation code: for
  // those, saving is blocked unless the body contains {{code}} (a code-less
  // "invitation" is unusable). Participant / regulator templates have no code
  // concept and are never forced through that check.
  pgm.sql(`
    CREATE TABLE message_templates (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id    UUID        NOT NULL REFERENCES editions(id),
      name          TEXT        NOT NULL,
      subject       TEXT        NOT NULL,
      body          TEXT        NOT NULL,
      audience_kind TEXT        NOT NULL DEFAULT 'firm'
                                CHECK (audience_kind IN ('firm','participant','regulator','upload')),
      requires_code BOOLEAN     NOT NULL DEFAULT FALSE,
      created_by    UUID        REFERENCES users(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (edition_id, name)
    )
  `);

  // ── message_batches ──────────────────────────────────────────────────────────
  // One send. `sending_service` is nullable and defaults to 'undecided' — the
  // provider is a configuration decision this surface deliberately does not make
  // (README open item). `audience_id`/`audience_label` record what was targeted.
  pgm.sql(`
    CREATE TABLE message_batches (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id      UUID        NOT NULL REFERENCES editions(id),
      template_id     UUID        NOT NULL REFERENCES message_templates(id),
      audience_id     TEXT        NOT NULL,
      audience_label  TEXT        NOT NULL,
      sending_service TEXT        NOT NULL DEFAULT 'undecided',
      sent_by         UUID        REFERENCES users(id),
      sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_message_batches_edition ON message_batches(edition_id)`);
  pgm.sql(`CREATE INDEX idx_message_batches_template ON message_batches(template_id)`);

  // ── message_recipients ───────────────────────────────────────────────────────
  // One row per addressee in a batch. `organization_id` is set for firm-derived
  // recipients (enables per-template dedup across batches); null for uploads and
  // participants. delivery_state is the core report (always populated). opened_at
  // / clicked_at are NULLABLE and only set when the sending service reports them
  // — a null opened_at means "not reported", NOT "zero opens". A click is a real
  // event; an open is a floor, never a reader count.
  pgm.sql(`
    CREATE TABLE message_recipients (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id        UUID        NOT NULL REFERENCES message_batches(id) ON DELETE CASCADE,
      edition_id      UUID        NOT NULL REFERENCES editions(id),
      organization_id UUID        REFERENCES organizations(id),
      recipient_email TEXT,
      firm_name       TEXT,
      code            TEXT,
      delivery_state  TEXT        NOT NULL DEFAULT 'sent'
                                  CHECK (delivery_state IN ('sent','delivered','bounced')),
      opened_at       TIMESTAMPTZ,
      clicked_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(`CREATE INDEX idx_message_recipients_batch ON message_recipients(batch_id)`);
  // Per-template dedup lookup: which firms already received a given template.
  pgm.sql(`
    CREATE INDEX idx_message_recipients_org
      ON message_recipients(edition_id, organization_id)
      WHERE organization_id IS NOT NULL
  `);

  // ── invitation_requests ──────────────────────────────────────────────────────
  // The operational other half of Phase 4's request-an-invitation flow. A firm
  // submits (UX-FRM-001); it surfaces here as a queue item carrying a contextual
  // flag, and is resolved by issuing a code or marking done. organization_id is
  // set only when the submitted firm name resolves to a register firm.
  pgm.sql(`
    CREATE TABLE invitation_requests (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id      UUID        NOT NULL REFERENCES editions(id),
      organization_id UUID        REFERENCES organizations(id),
      firm_name       TEXT        NOT NULL,
      requester_name  TEXT        NOT NULL,
      role            TEXT,
      email           TEXT        NOT NULL,
      phone           TEXT,
      flag            TEXT,
      resolved        BOOLEAN     NOT NULL DEFAULT FALSE,
      resolution      TEXT        CHECK (resolution IN ('code_issued','marked_done')),
      resolved_by     UUID        REFERENCES users(id),
      resolved_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgm.sql(
    `CREATE INDEX idx_invitation_requests_edition ON invitation_requests(edition_id, resolved)`,
  );

  // ── regulator_contacts (PROVISIONAL — pending UX-OPS-007) ─────────────────────
  // A minimal contact record so the "all three regulators" audience resolves.
  // UX-OPS-007 (regulator admin) will own this properly; flagged in README.
  pgm.sql(`
    CREATE TABLE regulator_contacts (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      org_code   TEXT        NOT NULL CHECK (org_code IN ('SEC','NGX','CSCS')),
      name       TEXT        NOT NULL,
      email      TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (org_code)
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS regulator_contacts`);
  pgm.sql(`DROP TABLE IF EXISTS invitation_requests`);
  pgm.sql(`DROP TABLE IF EXISTS message_recipients`);
  pgm.sql(`DROP TABLE IF EXISTS message_batches`);
  pgm.sql(`DROP TABLE IF EXISTS message_templates`);
};
