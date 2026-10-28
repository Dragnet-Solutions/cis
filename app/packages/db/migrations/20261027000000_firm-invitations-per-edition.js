'use strict';

/**
 * NEW-1 — a firm's invitations belong to an edition.
 *
 * The one-open-invitation rule was per firm and address across every edition,
 * so an invitation still open from the previous edition blocked the same
 * address being invited in the next one (bulk invite skipped 78 firms). The
 * rule is now per firm, address AND edition; an invitation with no edition
 * keeps its own bucket. No rows change: the new index is the old one plus the
 * edition, so every row that satisfied the old rule satisfies the new one.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE UNIQUE INDEX uq_firm_invitations_open_per_edition
      ON firm_invitations (
        organization_id,
        lower(email),
        COALESCE(edition_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
      WHERE status = 'pending';
    DROP INDEX uq_firm_invitations_open;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`
    CREATE UNIQUE INDEX uq_firm_invitations_open
      ON firm_invitations (organization_id, lower(email)) WHERE status = 'pending';
    DROP INDEX uq_firm_invitations_open_per_edition;
  `);
};
