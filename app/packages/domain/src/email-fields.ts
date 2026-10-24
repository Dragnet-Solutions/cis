import type { Pool, PoolClient } from 'pg';
import { getEditionById, listEditions } from '@cis/db';
import type { Edition } from '@cis/shared-types';
import { clientSurveyName } from '@cis/survey';

/**
 * Merge-field values shared by several emails, formatted the way people read
 * them in Lagos. Never invented: a date the edition does not hold is said to
 * be still to be confirmed.
 */

const LAGOS = 'Africa/Lagos';
export const DATE_TBC = 'To be confirmed';

/** "15 November 2026". */
export function fmtDate(d: Date | null | undefined, fallback = DATE_TBC): string {
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: LAGOS,
  }).format(d);
}

/** "22 October 2026, 14:05 (Lagos time)". */
export function fmtDateTime(d: Date): string {
  const date = fmtDate(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: LAGOS,
  }).format(d);
  return `${date}, ${time} (Lagos time)`;
}

/** A short reference for an invitation request, e.g. "REQ-3F9A1C2B". */
export const requestRef = (id: string): string =>
  `REQ-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** "Compliance survey": how a firm seat's survey is named in emails — the
 *  role only, never the seat's code (D-18). */
export const seatSurveyName = (seat: { seatCode: string; roleLabel: string }): string =>
  clientSurveyName(seat.seatCode, `${seat.roleLabel} survey`);

/** The edition an email is about: the given one, else the open one, else the latest. */
export async function editionForEmail(
  db: Pool | PoolClient,
  editionId?: string | null,
): Promise<Edition | null> {
  const pool = db as Pool;
  if (editionId) return getEditionById(pool, editionId);
  const editions = await listEditions(pool);
  return editions.find((e) => e.status === 'open') ?? editions[0] ?? null;
}

/** Survey open and close dates of an edition, as merge values. */
export function studyDates(edition: Edition | null): { open_date: string; close_date: string } {
  return {
    open_date: fmtDate(edition?.surveyOpenAt ?? edition?.plannedOpenAt ?? null),
    close_date: fmtDate(edition?.surveyCloseAt ?? null),
  };
}
