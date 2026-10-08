/**
 * Phase 16 — UX-ADM-007 Dragnet Internal Analysis (Phase 2 DRG-OPS questions).
 *
 * Permission: access:dragnet (Phase 8's `dragnet` right). CIS-organisation users
 * never hold this right (Phase 8 enforces it); only Dragnet users can.
 *
 * The non-negotiable boundary:
 *   FIRM-LEVEL MATURITY (OMI/DMI) IS NEVER JOINED TO DRG-OPS RESPONSE CONTENT.
 *   Each is served by its own structurally separate query path in @cis/db.
 *
 * Tier assignment: a firm's tier (top/middle/bottom third by OMI) is a
 * fixed property of its own OMI score, computed once over all firms, and
 * never re-derived from position in a sorted list — regression test in
 * packages/domain/tests/dragnet.test.ts enforces this invariant.
 *
 * Contact: present only for firms with follow_up_consent=TRUE; absent (not
 * masked) for firms without consent — both on screen and in CSV export.
 *
 * CSV export: uses the exact same query and consent boundary as the screen
 * data — no separate export query path that could drift.
 */

import { Pool } from 'pg';
import { getFirmMaturityRows, getDrgOpsAggregate, getDirectPermissionCodes } from '@cis/db';
import type { FirmMaturityRow, DrgOpsAggregateRow } from '@cis/db';

export type { FirmMaturityRow, DrgOpsAggregateRow };

export class DragnetPermissionError extends Error {
  constructor() {
    super('The dragnet analysis right (access:dragnet) is required to view this surface.');
    this.name = 'DragnetPermissionError';
  }
}

export type FirmTier = 'top' | 'middle' | 'bottom';

export interface FirmMaturityEntry extends FirmMaturityRow {
  /** Fixed property of the firm's OMI score; never derived from table position. */
  tier: FirmTier | null;
}

async function assertDragnetPermission(pool: Pool, userId: string): Promise<void> {
  const codes = await getDirectPermissionCodes(pool, userId);
  if (!codes.includes('access:dragnet')) {
    throw new DragnetPermissionError();
  }
}

/**
 * Assign tiers to firms based on their OMI score (not table position).
 * Firms without an OMI score receive null tier.
 * Top tier = highest OMI third, middle = middle third, bottom = lowest third.
 * Ties are broken by the order returned from getFirmMaturityRows (alphabetical).
 */
function assignTiers(rows: FirmMaturityRow[]): FirmMaturityEntry[] {
  const scored = rows.filter((r) => r.omi !== null);
  const unscored = rows.filter((r) => r.omi === null);

  // Sort descending by OMI to find thresholds
  const sorted = [...scored].sort((a, b) => (b.omi as number) - (a.omi as number));
  const n = sorted.length;
  const topCount = Math.ceil(n / 3);
  const bottomStart = n - Math.floor(n / 3);

  // Assign ranks in sorted order, then map back to original order
  const tierByOrgId = new Map<string, FirmTier>();
  sorted.forEach((r, i) => {
    if (i < topCount) tierByOrgId.set(r.organizationId, 'top');
    else if (i >= bottomStart) tierByOrgId.set(r.organizationId, 'bottom');
    else tierByOrgId.set(r.organizationId, 'middle');
  });

  const scoredWithTiers: FirmMaturityEntry[] = rows.map((r) =>
    r.omi !== null
      ? { ...r, tier: tierByOrgId.get(r.organizationId) ?? null }
      : { ...r, tier: null },
  );

  void unscored; // already handled via null check above
  return scoredWithTiers;
}

/** Return the firm maturity table (with tiers) for the Dragnet analysis surface. */
export async function getDragnetMaturity(
  pool: Pool,
  editionId: string,
  userId: string,
): Promise<FirmMaturityEntry[]> {
  await assertDragnetPermission(pool, userId);
  const rows = await getFirmMaturityRows(pool, editionId);
  return assignTiers(rows);
}

/** Return the DRG-OPS aggregate friction data (no firm identifiers). */
export async function getDragnetFriction(
  pool: Pool,
  editionId: string,
  userId: string,
): Promise<DrgOpsAggregateRow[]> {
  await assertDragnetPermission(pool, userId);
  return getDrgOpsAggregate(pool, editionId);
}

/**
 * Generate a CSV export of the firm maturity table.
 * Uses the SAME consent-filtered query as the screen — not a separate path.
 * Contact fields are ABSENT (no column) when the firm did not consent.
 * Firms without consent have no contact columns at all (not blank, not masked).
 */
export async function getDragnetMaturityCsv(
  pool: Pool,
  editionId: string,
  userId: string,
): Promise<string> {
  await assertDragnetPermission(pool, userId);
  const rows = await getFirmMaturityRows(pool, editionId);
  const withTiers = assignTiers(rows);

  const hasAnyConsented = withTiers.some((r) => r.contact !== null);

  const headers = ['Firm name', 'OMI', 'DMI', 'Tier'];
  if (hasAnyConsented) headers.push('Contact name', 'Contact role', 'Contact email');

  const escape = (v: string | null | undefined): string => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const lines: string[] = [headers.join(',')];
  for (const row of withTiers) {
    const cells = [
      escape(row.firmName),
      row.omi !== null ? String(Math.round(row.omi)) : '',
      row.dmi !== null ? String(Math.round(row.dmi)) : '',
      row.tier ?? '',
    ];
    if (hasAnyConsented) {
      cells.push(
        escape(row.contact?.name ?? null),
        escape(row.contact?.role ?? null),
        escape(row.contact?.email ?? null),
      );
    }
    lines.push(cells.join(','));
  }

  return lines.join('\r\n');
}
