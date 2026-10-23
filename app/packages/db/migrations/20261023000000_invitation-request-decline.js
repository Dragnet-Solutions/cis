'use strict';

/**
 * A request for an invitation can be DECLINED (with a reason the requester is
 * emailed, F-12), besides issuing the invitation or marking it done.
 *
 * Additive and reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE invitation_requests
      DROP CONSTRAINT IF EXISTS invitation_requests_resolution_check;
    ALTER TABLE invitation_requests
      ADD CONSTRAINT invitation_requests_resolution_check
      CHECK (resolution IN ('code_issued','marked_done','declined'));
    ALTER TABLE invitation_requests ADD COLUMN decline_reason TEXT;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`
    UPDATE invitation_requests SET resolution = 'marked_done' WHERE resolution = 'declined';
    ALTER TABLE invitation_requests DROP COLUMN IF EXISTS decline_reason;
    ALTER TABLE invitation_requests
      DROP CONSTRAINT IF EXISTS invitation_requests_resolution_check;
    ALTER TABLE invitation_requests
      ADD CONSTRAINT invitation_requests_resolution_check
      CHECK (resolution IN ('code_issued','marked_done'));
  `);
};
