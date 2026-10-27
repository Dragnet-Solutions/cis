'use strict';

/**
 * NEW-2 — one-file CIS firm import.
 *
 * The firm directory import now carries each firm's contact (name, email,
 * phone) and, optionally, its registration number, so a firm can be invited
 * straight from the file instead of through a second upload matched by name.
 * One row per firm: the contact to invite. Additive — a new table only;
 * nothing existing changes. Removing a firm removes its contact.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS firm_contacts (
      organization_id     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      contact_name        TEXT,
      email               TEXT,
      phone               TEXT,
      registration_number TEXT,
      updated_by          UUID REFERENCES users(id),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS firm_contacts`);
};
