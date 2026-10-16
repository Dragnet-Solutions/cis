'use strict';

/**
 * An invitation batch recipient the platform holds no email address for is
 * recorded as `not_sent` — visible in the batch report, never counted as sent,
 * and not treated as "already sent this template" (so a later batch reaches
 * the firm once an address exists).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE message_recipients DROP CONSTRAINT message_recipients_delivery_state_check;
    ALTER TABLE message_recipients ADD CONSTRAINT message_recipients_delivery_state_check
      CHECK (delivery_state IN ('sent', 'delivered', 'bounced', 'not_sent'));
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`
    DELETE FROM message_recipients WHERE delivery_state = 'not_sent';
    ALTER TABLE message_recipients DROP CONSTRAINT message_recipients_delivery_state_check;
    ALTER TABLE message_recipients ADD CONSTRAINT message_recipients_delivery_state_check
      CHECK (delivery_state IN ('sent', 'delivered', 'bounced'));
  `);
};
