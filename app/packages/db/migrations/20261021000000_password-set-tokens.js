'use strict';

/**
 * Operator password-set links. An operator added on People & access (or one
 * who asks for a reset) is emailed a single-use link carrying a random token;
 * opening it lets them choose their own password. Only the SHA-256 of the
 * token is stored — the raw token exists only in the email.
 *
 * At most one usable link per person: issuing a new one revokes older unused
 * ones (`revoked_at`). `used_at` is set only when a password was actually set.
 *
 * Additive and reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE password_set_tokens (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID        NOT NULL REFERENCES users(id),
      token_hash  TEXT        NOT NULL UNIQUE,
      purpose     TEXT        NOT NULL CHECK (purpose IN ('invite', 'reset')),
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      revoked_at  TIMESTAMPTZ,
      created_by  UUID        REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_password_set_tokens_user ON password_set_tokens (user_id, created_at DESC);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS password_set_tokens;`);
};
