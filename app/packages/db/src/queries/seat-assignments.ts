import { Pool } from 'pg';
import type { SeatAssignment, SeatState } from '@cis/shared-types';
import { query } from '../client';

interface RawSeatRow {
  id: string;
  edition_id: string;
  organization_id: string;
  seat_code: 'S1' | 'S2' | 'S3';
  role_label: string;
  assigned_name: string | null;
  assigned_email: string | null;
  state: SeatState;
  is_self: boolean;
  stalled_at: string | null;
  respondent_id: string | null;
  link_token: string;
  created_at: Date;
  updated_at: Date;
}

function mapSeat(row: RawSeatRow): SeatAssignment {
  return {
    id: row.id,
    editionId: row.edition_id,
    organizationId: row.organization_id,
    seatCode: row.seat_code,
    roleLabel: row.role_label,
    assignedName: row.assigned_name,
    assignedEmail: row.assigned_email,
    state: row.state,
    isSelf: row.is_self,
    stalledAt: row.stalled_at,
    respondentId: row.respondent_id,
    linkToken: row.link_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The three seats a firm has for an edition, in seat order. Creates the empty
 *  trio on first read so callers always see all three. */
export async function ensureSeats(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<SeatAssignment[]> {
  await query(
    pool,
    `INSERT INTO seat_assignments (edition_id, organization_id, seat_code, role_label)
     VALUES ($1,$2,'S1','MD or Chief Executive'),
            ($1,$2,'S2','Compliance'),
            ($1,$2,'S3','Operations')
     ON CONFLICT (edition_id, organization_id, seat_code) DO NOTHING`,
    [editionId, organizationId],
  );
  return listSeats(pool, editionId, organizationId);
}

export async function listSeats(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<SeatAssignment[]> {
  const result = await query<RawSeatRow>(
    pool,
    `SELECT * FROM seat_assignments
      WHERE edition_id = $1 AND organization_id = $2
      ORDER BY seat_code`,
    [editionId, organizationId],
  );
  return result.rows.map(mapSeat);
}

export async function getSeat(
  pool: Pool,
  editionId: string,
  organizationId: string,
  seatCode: string,
): Promise<SeatAssignment | null> {
  const result = await query<RawSeatRow>(
    pool,
    `SELECT * FROM seat_assignments
      WHERE edition_id = $1 AND organization_id = $2 AND seat_code = $3`,
    [editionId, organizationId, seatCode],
  );
  const row = result.rows[0];
  return row ? mapSeat(row) : null;
}

/** Assign (or re-assign) a seat: sets name/email and moves it to 'invited'.
 *  A fresh `link_token` is minted every time — the previous occupant's link
 *  (if any) stops resolving to anything immediately. */
export async function assignSeat(
  pool: Pool,
  data: {
    editionId: string;
    organizationId: string;
    seatCode: string;
    assignedName: string;
    assignedEmail: string;
    isSelf?: boolean;
  },
): Promise<SeatAssignment> {
  const result = await query<RawSeatRow>(
    pool,
    `UPDATE seat_assignments
        SET assigned_name = $4, assigned_email = $5,
            state = 'invited', is_self = $6,
            stalled_at = NULL, respondent_id = NULL, link_token = gen_random_uuid(),
            updated_at = NOW()
      WHERE edition_id = $1 AND organization_id = $2 AND seat_code = $3
      RETURNING *`,
    [
      data.editionId,
      data.organizationId,
      data.seatCode,
      data.assignedName,
      data.assignedEmail,
      data.isSelf ?? false,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Seat ${data.seatCode} not found`);
  return mapSeat(row);
}

/** Clear a seat back to empty (used when replacing an occupant). Also mints a
 *  fresh `link_token` — nobody holding the old link can land on whatever gets
 *  assigned to this seat next. */
export async function clearSeat(
  pool: Pool,
  editionId: string,
  organizationId: string,
  seatCode: string,
): Promise<SeatAssignment> {
  const result = await query<RawSeatRow>(
    pool,
    `UPDATE seat_assignments
        SET assigned_name = NULL, assigned_email = NULL, state = 'empty',
            is_self = FALSE, stalled_at = NULL, respondent_id = NULL,
            link_token = gen_random_uuid(), updated_at = NOW()
      WHERE edition_id = $1 AND organization_id = $2 AND seat_code = $3
      RETURNING *`,
    [editionId, organizationId, seatCode],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Seat ${seatCode} not found`);
  return mapSeat(row);
}

/** Resolve a seat by its public link token — the ONLY lookup a respondent's
 *  entry-point request is allowed to use (never by the seat's own stable id,
 *  which survives reassignment). */
export async function getSeatByLinkToken(
  pool: Pool,
  linkToken: string,
): Promise<SeatAssignment | null> {
  const result = await query<RawSeatRow>(
    pool,
    `SELECT * FROM seat_assignments WHERE link_token = $1`,
    [linkToken],
  );
  const row = result.rows[0];
  return row ? mapSeat(row) : null;
}

/** Move a seat's state (invited→started→complete, or flag stalled). */
export async function setSeatState(
  pool: Pool,
  data: {
    editionId: string;
    organizationId: string;
    seatCode: string;
    state: SeatState;
    stalledAt?: string | null;
    respondentId?: string | null;
  },
): Promise<SeatAssignment> {
  const result = await query<RawSeatRow>(
    pool,
    `UPDATE seat_assignments
        SET state = $4,
            stalled_at = $5,
            respondent_id = COALESCE($6, respondent_id),
            updated_at = NOW()
      WHERE edition_id = $1 AND organization_id = $2 AND seat_code = $3
      RETURNING *`,
    [
      data.editionId,
      data.organizationId,
      data.seatCode,
      data.state,
      data.stalledAt ?? null,
      data.respondentId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Seat ${data.seatCode} not found`);
  return mapSeat(row);
}

/**
 * The firm-facing seat view: seat + role + STATE only. This is a distinct
 * accessor from the full row so the visibility boundary is explicit — it never
 * selects respondent_id or anything that could reach answer content.
 */
export async function getSeatStatuses(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<
  Array<{ seatCode: string; roleLabel: string; state: SeatState; stalledAt: string | null }>
> {
  const result = await query<{
    seat_code: string;
    role_label: string;
    state: SeatState;
    stalled_at: string | null;
  }>(
    pool,
    `SELECT seat_code, role_label, state, stalled_at
       FROM seat_assignments
      WHERE edition_id = $1 AND organization_id = $2
      ORDER BY seat_code`,
    [editionId, organizationId],
  );
  return result.rows.map((r) => ({
    seatCode: r.seat_code,
    roleLabel: r.role_label,
    state: r.state,
    stalledAt: r.stalled_at,
  }));
}
