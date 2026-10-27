import { Pool, PoolClient } from 'pg';
import { query } from '../client';

/**
 * Invitations for a firm to claim its space. An operator emails the firm's
 * contact a link carrying an unguessable token; opening it lets that person
 * claim the firm's space, and the claim records which invitation it used.
 *
 * Whether an invitation has expired is the domain's call (pending and
 * `expires_at` in the past) — the stored status stays `pending`.
 */
export type FirmInvitationStatus = 'pending' | 'accepted' | 'revoked';

/** A pool, or a client inside a transaction. */
type Db = Pool | PoolClient;

export interface FirmInvitation {
  id: string;
  organizationId: string;
  editionId: string | null;
  email: string;
  contactName: string | null;
  token: string;
  status: FirmInvitationStatus;
  expiresAt: Date;
  invitedBy: string;
  createdAt: Date;
  lastSentAt: Date;
  sendCount: number;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export interface FirmInvitationWithFirm extends FirmInvitation {
  firmName: string;
}

interface RawInvitationRow {
  id: string;
  organization_id: string;
  edition_id: string | null;
  email: string;
  contact_name: string | null;
  token: string;
  status: FirmInvitationStatus;
  expires_at: Date;
  invited_by: string;
  created_at: Date;
  last_sent_at: Date;
  send_count: number;
  accepted_at: Date | null;
  revoked_at: Date | null;
  display_name?: string;
}

const mapInvitation = (r: RawInvitationRow): FirmInvitation => ({
  id: r.id,
  organizationId: r.organization_id,
  editionId: r.edition_id,
  email: r.email,
  contactName: r.contact_name,
  token: r.token,
  status: r.status,
  expiresAt: r.expires_at,
  invitedBy: r.invited_by,
  createdAt: r.created_at,
  lastSentAt: r.last_sent_at,
  sendCount: r.send_count,
  acceptedAt: r.accepted_at,
  revokedAt: r.revoked_at,
});

const mapWithFirm = (r: RawInvitationRow): FirmInvitationWithFirm => ({
  ...mapInvitation(r),
  firmName: r.display_name ?? '',
});

/** PoolClient's query is call-compatible with Pool's; the helper is typed on Pool. */
const asPool = (db: Db): Pool => db as Pool;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createFirmInvitation(
  db: Db,
  data: {
    organizationId: string;
    editionId?: string | null;
    email: string;
    contactName?: string | null;
    expiresAt: Date;
    invitedBy: string;
  },
): Promise<FirmInvitation> {
  const res = await query<RawInvitationRow>(
    asPool(db),
    `INSERT INTO firm_invitations
       (organization_id, edition_id, email, contact_name, expires_at, invited_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.organizationId,
      data.editionId ?? null,
      data.email,
      data.contactName ?? null,
      data.expiresAt,
      data.invitedBy,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('firm invitation insert returned no rows');
  return mapInvitation(row);
}

export async function getFirmInvitationById(db: Db, id: string): Promise<FirmInvitation | null> {
  if (!UUID_RE.test(id)) return null;
  const res = await query<RawInvitationRow>(
    asPool(db),
    'SELECT * FROM firm_invitations WHERE id = $1',
    [id],
  );
  const row = res.rows[0];
  return row ? mapInvitation(row) : null;
}

/** The invitation a link carries, with the firm's name. A malformed token finds nothing. */
export async function getFirmInvitationByToken(
  db: Db,
  token: string,
  opts: { forUpdate?: boolean } = {},
): Promise<FirmInvitationWithFirm | null> {
  if (!UUID_RE.test(token)) return null;
  const res = await query<RawInvitationRow>(
    asPool(db),
    `SELECT fi.*, o.display_name
       FROM firm_invitations fi
       JOIN organizations o ON o.id = fi.organization_id
      WHERE fi.token = $1${opts.forUpdate ? ' FOR UPDATE OF fi' : ''}`,
    [token],
  );
  const row = res.rows[0];
  return row ? mapWithFirm(row) : null;
}

/**
 * The open (pending) invitation for this firm and address in this edition, if
 * any. Invitations belong to an edition: one still open from an earlier
 * edition is not this edition's (NEW-1).
 */
export async function getPendingFirmInvitation(
  db: Db,
  organizationId: string,
  email: string,
  editionId: string | null,
): Promise<FirmInvitation | null> {
  const res = await query<RawInvitationRow>(
    asPool(db),
    `SELECT * FROM firm_invitations
      WHERE organization_id = $1 AND lower(email) = lower($2) AND status = 'pending'
        AND edition_id IS NOT DISTINCT FROM $3`,
    [organizationId, email, editionId],
  );
  const row = res.rows[0];
  return row ? mapInvitation(row) : null;
}

/** A firm's invitations, newest first — only one edition's when `editionId` is given. */
export async function listFirmInvitationsForOrganization(
  db: Db,
  organizationId: string,
  editionId?: string,
): Promise<FirmInvitationWithFirm[]> {
  const res = await query<RawInvitationRow>(
    asPool(db),
    `SELECT fi.*, o.display_name
       FROM firm_invitations fi
       JOIN organizations o ON o.id = fi.organization_id
      WHERE fi.organization_id = $1
        AND ($2::uuid IS NULL OR fi.edition_id = $2)
      ORDER BY fi.created_at DESC`,
    [organizationId, editionId ?? null],
  );
  return res.rows.map(mapWithFirm);
}

export async function listFirmInvitationsForEdition(
  db: Db,
  editionId: string,
): Promise<FirmInvitationWithFirm[]> {
  const res = await query<RawInvitationRow>(
    asPool(db),
    `SELECT fi.*, o.display_name
       FROM firm_invitations fi
       JOIN organizations o ON o.id = fi.organization_id
      WHERE fi.edition_id = $1
      ORDER BY o.display_name, fi.created_at DESC`,
    [editionId],
  );
  return res.rows.map(mapWithFirm);
}

/** Records another send: last_sent_at now, send_count + 1, a fresh expiry. */
export async function markFirmInvitationSent(
  db: Db,
  id: string,
  expiresAt: Date,
): Promise<FirmInvitation> {
  const res = await query<RawInvitationRow>(
    asPool(db),
    `UPDATE firm_invitations
        SET last_sent_at = NOW(), send_count = send_count + 1, expires_at = $2
      WHERE id = $1
      RETURNING *`,
    [id, expiresAt],
  );
  const row = res.rows[0];
  if (!row) throw new Error('firm invitation not found');
  return mapInvitation(row);
}

/** Revokes a pending invitation. Returns null if it was not pending. */
export async function revokeFirmInvitation(db: Db, id: string): Promise<FirmInvitation | null> {
  const res = await query<RawInvitationRow>(
    asPool(db),
    `UPDATE firm_invitations
        SET status = 'revoked', revoked_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id],
  );
  const row = res.rows[0];
  return row ? mapInvitation(row) : null;
}

/** Marks a pending invitation accepted (run inside the claim's transaction). */
export async function acceptFirmInvitation(db: Db, id: string): Promise<FirmInvitation | null> {
  const res = await query<RawInvitationRow>(
    asPool(db),
    `UPDATE firm_invitations
        SET status = 'accepted', accepted_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id],
  );
  const row = res.rows[0];
  return row ? mapInvitation(row) : null;
}

/** Records on the firm's claim which invitation it used. */
export async function setFirmClaimInvitation(
  db: Db,
  claimId: string,
  invitationId: string,
): Promise<void> {
  await query(asPool(db), 'UPDATE firm_claims SET invitation_id = $2 WHERE id = $1', [
    claimId,
    invitationId,
  ]);
}

/** Whether the firm has a pending, unexpired invitation for this edition. */
export async function hasOpenFirmInvitation(
  db: Db,
  organizationId: string,
  editionId: string,
): Promise<boolean> {
  const res = await query<{ open: boolean }>(
    asPool(db),
    `SELECT EXISTS (
       SELECT 1 FROM firm_invitations
        WHERE organization_id = $1 AND edition_id = $2
          AND status = 'pending' AND expires_at > NOW()
     ) AS open`,
    [organizationId, editionId],
  );
  return res.rows[0]?.open ?? false;
}

/**
 * The active firms taking part in an edition (any participation status except
 * withdrawn), by name — the candidates for a bulk invitation.
 */
export async function listEditionFirmsForInvitation(
  db: Db,
  editionId: string,
): Promise<Array<{ id: string; slug: string; displayName: string }>> {
  const res = await query<{ id: string; slug: string; display_name: string }>(
    asPool(db),
    `SELECT o.id, o.slug, o.display_name
       FROM organizations o
       JOIN edition_participation ep ON ep.organization_id = o.id
      WHERE ep.edition_id = $1
        AND ep.status <> 'withdrawn'
        AND o.org_type = 'firm'
        AND o.is_active = TRUE
      ORDER BY o.display_name`,
    [editionId],
  );
  return res.rows.map((r) => ({ id: r.id, slug: r.slug, displayName: r.display_name }));
}
