'use strict';

/**
 * Phase 25 — Task D, Part 6: a real entry point for an assigned S1/S2/S3
 * seat, routing into the existing shared journey shell.
 *
 * A seat's own `id` is stable across reassignment (assignSeat/clearSeat
 * update the row in place), so it cannot be used as the link a coordinator
 * hands to an assignee: replacementCost's own warning already promises
 * "Their link stops working straight away" once a seat is reassigned. This
 * column is the opaque, unguessable token that link actually carries —
 * regenerated on every assign AND every clear, so a stale link resolves to
 * nothing rather than silently landing on whoever now holds the seat.
 *
 * Reversible. Schema only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE seat_assignments
      ADD COLUMN link_token UUID NOT NULL DEFAULT gen_random_uuid()
  `);
  pgm.sql(`CREATE UNIQUE INDEX uniq_seat_link_token ON seat_assignments(link_token)`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (pgm) {
  pgm.sql(`DROP INDEX IF EXISTS uniq_seat_link_token`);
  pgm.sql(`ALTER TABLE seat_assignments DROP COLUMN IF EXISTS link_token`);
};
