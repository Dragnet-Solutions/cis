'use strict';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = function (pgm) {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

  // ── organizations ──────────────────────────────────────────────────────────
  // Stable identity for firms/institutions. Persists across all editions.
  // Never contains year-specific state — edition_participation holds that.
  pgm.sql(`
    CREATE TABLE organizations (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      slug         TEXT        NOT NULL UNIQUE,
      display_name TEXT        NOT NULL,
      org_type     TEXT        NOT NULL
                               CHECK (org_type IN ('firm', 'institution', 'regulator')),
      is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
      metadata     JSONB       NOT NULL DEFAULT '{}',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── editions ───────────────────────────────────────────────────────────────
  // First-class entity. label = human identifier (e.g. "2026", "2027-DRAFT").
  // No year-suffix tables — a new edition is a new row, not a new schema.
  pgm.sql(`
    CREATE TABLE editions (
      id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      label                TEXT        NOT NULL UNIQUE,
      status               TEXT        NOT NULL DEFAULT 'draft'
                                       CHECK (status IN ('draft','open','locked','archived')),
      survey_open_at       TIMESTAMPTZ,
      survey_close_at      TIMESTAMPTZ,
      results_published_at TIMESTAMPTZ,
      prior_edition_id     UUID        REFERENCES editions(id),
      locked_at            TIMESTAMPTZ,
      locked_by            UUID,       -- FK to users added below after users table
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── users ──────────────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE users (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      email           TEXT        NOT NULL UNIQUE,
      password_hash   TEXT        NOT NULL,
      display_name    TEXT        NOT NULL,
      is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
      last_login_at   TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Deferred FK: editions.locked_by → users.id
  pgm.sql(`
    ALTER TABLE editions
      ADD CONSTRAINT editions_locked_by_fk
      FOREIGN KEY (locked_by) REFERENCES users(id)
  `);

  // ── RBAC ───────────────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE roles (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT        NOT NULL UNIQUE,
      description TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE permissions (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      code            TEXT        NOT NULL UNIQUE,
      description     TEXT,
      permission_type TEXT        NOT NULL DEFAULT 'standard'
                                  CHECK (permission_type IN (
                                    'standard',
                                    'can_request_critical_action',
                                    'can_approve_critical_action'
                                  )),
      action_scope    TEXT,       -- for critical-action permissions: which action_type
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE role_permissions (
      role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    )
  `);

  pgm.sql(`
    CREATE TABLE user_roles (
      user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id    UUID        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      granted_by UUID        REFERENCES users(id),
      PRIMARY KEY (user_id, role_id)
    )
  `);

  // ── critical_actions ───────────────────────────────────────────────────────
  // Generic maker-checker workflow table. Edition lock, score approval, report
  // release — all hang off this pattern so the constraint is implemented once.
  pgm.sql(`
    CREATE TABLE critical_actions (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      action_type      TEXT        NOT NULL,
      status           TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','approved','rejected','cancelled')),
      requested_by     UUID        NOT NULL REFERENCES users(id),
      requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_by      UUID        REFERENCES users(id),
      approved_at      TIMESTAMPTZ,
      rejected_by      UUID        REFERENCES users(id),
      rejected_at      TIMESTAMPTZ,
      rejection_reason TEXT,
      payload          JSONB       NOT NULL DEFAULT '{}',
      edition_id       UUID        REFERENCES editions(id),
      CONSTRAINT maker_checker_no_self_approval
        CHECK (approved_by IS NULL OR approved_by <> requested_by),
      CONSTRAINT maker_checker_no_self_rejection
        CHECK (rejected_by IS NULL OR rejected_by <> requested_by)
    )
  `);

  // ── edition_participation ──────────────────────────────────────────────────
  // Per-year state for an organisation. Never on organizations itself.
  pgm.sql(`
    CREATE TABLE edition_participation (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id      UUID        NOT NULL REFERENCES editions(id),
      organization_id UUID        NOT NULL REFERENCES organizations(id),
      status          TEXT        NOT NULL DEFAULT 'invited'
                                  CHECK (status IN ('invited','active','completed','withdrawn')),
      invited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (edition_id, organization_id)
    )
  `);

  // ── instrument_definitions + versions ──────────────────────────────────────
  // Versioned instrument metadata. Full question schema populated in Phase 2.
  // The structure here proves the versioning/freeze pattern works.
  pgm.sql(`
    CREATE TABLE instrument_definitions (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      code            TEXT        NOT NULL UNIQUE,
      name            TEXT        NOT NULL,
      instrument_type TEXT        NOT NULL DEFAULT 'survey'
                                  CHECK (instrument_type IN ('survey','institutional','regulator')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE instrument_definition_versions (
      id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_definition_id UUID        NOT NULL REFERENCES instrument_definitions(id),
      version_number           INTEGER     NOT NULL,
      schema_snapshot          JSONB       NOT NULL DEFAULT '{}',
      is_frozen                BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by               UUID        REFERENCES users(id),
      frozen_at                TIMESTAMPTZ,
      frozen_by                UUID        REFERENCES users(id),
      UNIQUE (instrument_definition_id, version_number)
    )
  `);

  // ── edition_instrument_snapshots ───────────────────────────────────────────
  // Frozen link between an edition and the exact instrument version it uses.
  // After the edition is locked this row is the authoritative "what version
  // did 2026 run" — it must never be modified or deleted.
  pgm.sql(`
    CREATE TABLE edition_instrument_snapshots (
      id                               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      edition_id                       UUID        NOT NULL REFERENCES editions(id),
      instrument_definition_version_id UUID        NOT NULL
                                                   REFERENCES instrument_definition_versions(id),
      frozen_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      frozen_by                        UUID        REFERENCES users(id),
      UNIQUE (edition_id, instrument_definition_version_id)
    )
  `);

  // ── audit_log ──────────────────────────────────────────────────────────────
  // Immutable, append-only. Triggers below prevent UPDATE and DELETE.
  pgm.sql(`
    CREATE TABLE audit_log (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id    UUID        REFERENCES users(id),
      action_type TEXT        NOT NULL,
      entity_type TEXT        NOT NULL,
      entity_id   UUID,
      edition_id  UUID        REFERENCES editions(id),
      old_value   JSONB,
      new_value   JSONB,
      reason      TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address  INET,
      user_agent  TEXT
    )
  `);

  // Immutability enforcement — UPDATE and DELETE are blocked at the DB level.
  // TRUNCATE is intentionally not blocked so test teardown can clear the table.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is immutable: % operations are not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `);

  pgm.sql(`
    CREATE TRIGGER audit_log_no_update
      BEFORE UPDATE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification()
  `);

  pgm.sql(`
    CREATE TRIGGER audit_log_no_delete
      BEFORE DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification()
  `);

  // ── Indexes ────────────────────────────────────────────────────────────────
  pgm.sql(`CREATE INDEX idx_editions_status ON editions(status)`);
  pgm.sql(`CREATE INDEX idx_edition_participation_edition ON edition_participation(edition_id)`);
  pgm.sql(`CREATE INDEX idx_edition_participation_org ON edition_participation(organization_id)`);
  pgm.sql(
    `CREATE INDEX idx_instrument_def_ver_def ON instrument_definition_versions(instrument_definition_id)`,
  );
  pgm.sql(`CREATE INDEX idx_edition_snapshots_edition ON edition_instrument_snapshots(edition_id)`);
  pgm.sql(`CREATE INDEX idx_audit_log_actor ON audit_log(actor_id)`);
  pgm.sql(`CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id)`);
  pgm.sql(`CREATE INDEX idx_audit_log_edition ON audit_log(edition_id)`);
  pgm.sql(`CREATE INDEX idx_audit_log_occurred_at ON audit_log(occurred_at DESC)`);
  pgm.sql(`CREATE INDEX idx_critical_actions_status ON critical_actions(status)`);
  pgm.sql(`CREATE INDEX idx_critical_actions_edition ON critical_actions(edition_id)`);
  pgm.sql(`CREATE INDEX idx_user_roles_user ON user_roles(user_id)`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log`);
  pgm.sql(`DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log`);
  pgm.sql(`DROP FUNCTION IF EXISTS prevent_audit_log_modification()`);
  pgm.sql(`DROP TABLE IF EXISTS audit_log`);
  pgm.sql(`DROP TABLE IF EXISTS edition_instrument_snapshots`);
  pgm.sql(`DROP TABLE IF EXISTS instrument_definition_versions`);
  pgm.sql(`DROP TABLE IF EXISTS instrument_definitions`);
  pgm.sql(`DROP TABLE IF EXISTS edition_participation`);
  pgm.sql(`DROP TABLE IF EXISTS critical_actions`);
  pgm.sql(`DROP TABLE IF EXISTS user_roles`);
  pgm.sql(`DROP TABLE IF EXISTS role_permissions`);
  pgm.sql(`DROP TABLE IF EXISTS permissions`);
  pgm.sql(`DROP TABLE IF EXISTS roles`);
  pgm.sql(`ALTER TABLE editions DROP CONSTRAINT IF EXISTS editions_locked_by_fk`);
  pgm.sql(`DROP TABLE IF EXISTS users`);
  pgm.sql(`DROP TABLE IF EXISTS editions`);
  pgm.sql(`DROP TABLE IF EXISTS organizations`);
};
