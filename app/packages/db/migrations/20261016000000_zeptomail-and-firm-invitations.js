'use strict';

/**
 * Email through ZeptoMail, and invitations for firms.
 *
 * 1. email_outbox grows what a real transactional sender needs: an HTML body
 *    and the recipient's name, retries with back-off (attempts,
 *    next_attempt_at — also the lease that stops two API pods sending the same
 *    notice), and which provider sent it with its message id.
 *
 * 2. firm_invitations: an operator invites a firm by emailing its contact a
 *    link that carries an unguessable token. Opening the link lets that person
 *    claim the firm's space; the claim records which invitation it used. One
 *    open invitation per firm and email address at a time.
 *
 * Additive and reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE email_outbox
      ADD COLUMN to_name             TEXT,
      ADD COLUMN body_html           TEXT,
      ADD COLUMN attempts            INTEGER     NOT NULL DEFAULT 0,
      ADD COLUMN next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN provider            TEXT,
      ADD COLUMN provider_message_id TEXT;

    DROP INDEX IF EXISTS idx_email_outbox_queued;
    CREATE INDEX idx_email_outbox_due ON email_outbox (next_attempt_at) WHERE status = 'queued';

    CREATE TABLE firm_invitations (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  UUID        NOT NULL REFERENCES organizations(id),
      edition_id       UUID        REFERENCES editions(id),
      email            TEXT        NOT NULL,
      contact_name     TEXT,
      token            UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      status           TEXT        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted', 'revoked')),
      expires_at       TIMESTAMPTZ NOT NULL,
      invited_by       UUID        NOT NULL REFERENCES users(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      send_count       INTEGER     NOT NULL DEFAULT 1,
      accepted_at      TIMESTAMPTZ,
      revoked_at       TIMESTAMPTZ
    );
    CREATE INDEX idx_firm_invitations_org ON firm_invitations (organization_id, created_at DESC);
    CREATE UNIQUE INDEX uq_firm_invitations_open
      ON firm_invitations (organization_id, lower(email)) WHERE status = 'pending';

    ALTER TABLE firm_claims ADD COLUMN invitation_id UUID REFERENCES firm_invitations(id);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE firm_claims DROP COLUMN IF EXISTS invitation_id;
    DROP TABLE IF EXISTS firm_invitations;
    DROP INDEX IF EXISTS idx_email_outbox_due;
    CREATE INDEX idx_email_outbox_queued ON email_outbox (created_at) WHERE status = 'queued';
    ALTER TABLE email_outbox
      DROP COLUMN IF EXISTS provider_message_id,
      DROP COLUMN IF EXISTS provider,
      DROP COLUMN IF EXISTS next_attempt_at,
      DROP COLUMN IF EXISTS attempts,
      DROP COLUMN IF EXISTS body_html,
      DROP COLUMN IF EXISTS to_name;
  `);
};
