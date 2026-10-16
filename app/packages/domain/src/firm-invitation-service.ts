import { Pool } from 'pg';
import {
  withTransaction,
  getOrganizationById,
  getEditionById,
  getFirmClaim,
  getActiveLead,
  createFirmInvitation,
  getFirmInvitationById,
  getFirmInvitationByToken,
  getPendingFirmInvitation,
  listFirmInvitationsForOrganization,
  listFirmInvitationsForEdition,
  markFirmInvitationSent,
  revokeFirmInvitation as dbRevokeFirmInvitation,
  listEmailsFor,
  type FirmInvitation,
  type FirmInvitationWithFirm,
  type EmailStatus,
} from '@cis/db';
import { requirePermission, type RbacContext } from '@cis/auth';
import { writeAudit } from '@cis/audit';
import { DomainError } from './errors';
import { queueNotice } from './email-content';

/**
 * Inviting a firm — an operator emails a firm's contact a personal link that
 * opens the firm portal's claim view for that firm. The link carries an
 * unguessable token; it expires (14 days by default, FIRM_INVITE_TTL_DAYS),
 * can be resent (fresh expiry, same link) or revoked, and is used up by the
 * claim it opens. Writing to firms needs the "access:send" right; every send,
 * resend and revoke is audited. A firm that already has a space is never
 * invited again — its coordinators sign in instead.
 *
 * The invitation is to the FIRM: the person who claims may use a different
 * address from the one invited (that is recorded, not refused).
 */

export const FIRM_INVITATION_EMAIL_KIND = 'firm-invitation';
const SEND_PERMISSION = 'access:send';

export type FirmInvitationErrorCode =
  | 'FIRM_NOT_FOUND'
  | 'NOT_A_FIRM'
  | 'FIRM_INACTIVE'
  | 'EDITION_NOT_FOUND'
  | 'EMAIL_INVALID'
  | 'ALREADY_CLAIMED'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'REVOKED'
  | 'USED'
  | 'WRONG_FIRM'
  | 'NOT_PENDING';

export class FirmInvitationError extends DomainError {
  constructor(
    message: string,
    public readonly reason: FirmInvitationErrorCode,
  ) {
    super(message, reason);
  }
}

export interface InviteContext {
  actorId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The firm portal's origin, e.g. https://dev-cis.idhub.ng. */
  portalUrl: string;
}

export type FirmInvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface FirmInvitationDelivery {
  status: EmailStatus;
  error: string | null;
  at: Date;
}

export interface FirmInvitationView {
  id: string;
  organizationId: string;
  firmName: string;
  editionId: string | null;
  email: string;
  contactName: string | null;
  state: FirmInvitationState;
  createdAt: Date;
  lastSentAt: Date;
  sendCount: number;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  /** The latest invitation email's delivery, or null if none was queued. */
  delivery: FirmInvitationDelivery | null;
}

export interface InvitationLookup {
  organizationId: string;
  firmName: string;
  email: string;
  contactName: string | null;
  expiresAt: Date;
}

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** Days an invitation stays open: FIRM_INVITE_TTL_DAYS, else 14. */
export function firmInviteTtlDays(): number {
  const raw = Number(process.env['FIRM_INVITE_TTL_DAYS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 14;
}

const newExpiry = (now = new Date()) =>
  new Date(now.getTime() + firmInviteTtlDays() * 24 * 60 * 60 * 1000);

export function invitationState(
  inv: Pick<FirmInvitation, 'status' | 'expiresAt'>,
  now = new Date(),
): FirmInvitationState {
  if (inv.status === 'pending' && inv.expiresAt.getTime() <= now.getTime()) return 'expired';
  return inv.status;
}

/** "30 October 2026" in Lagos time. */
function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  }).format(d);
}

/** The claim link: `<portal origin>/firm?invite=<token>`. */
export function invitationLink(portalUrl: string, token: string): string {
  const base = portalUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/firm$/, '');
  return `${base}/firm?invite=${encodeURIComponent(token)}`;
}

async function assertInvitableFirm(pool: Pool, organizationId: string) {
  const org = await getOrganizationById(pool, organizationId);
  if (!org) throw new FirmInvitationError('That firm is not in the directory', 'FIRM_NOT_FOUND');
  if (org.orgType !== 'firm') {
    throw new FirmInvitationError('Only a stockbroking firm can be invited', 'NOT_A_FIRM');
  }
  if (!org.isActive) {
    throw new FirmInvitationError(
      'That firm is no longer active in the directory',
      'FIRM_INACTIVE',
    );
  }
  return org;
}

async function assertNotClaimed(pool: Pool, organizationId: string): Promise<void> {
  const claim = await getFirmClaim(pool, organizationId);
  const lead = claim ? null : await getActiveLead(pool, organizationId);
  if (claim || lead) {
    throw new FirmInvitationError(
      'This firm has already set up its space. Its coordinators sign in to the firm portal instead.',
      'ALREADY_CLAIMED',
    );
  }
}

/** Queues the invitation email for `inv` (inside the caller's transaction). */
async function queueInvitationEmail(
  db: Pool,
  inv: FirmInvitation,
  firmName: string,
  portalUrl: string,
): Promise<void> {
  const link = invitationLink(portalUrl, inv.token);
  const greeting = inv.contactName?.trim() ? `Dear ${inv.contactName.trim()},` : 'Hello,';
  await queueNotice(db, {
    kind: FIRM_INVITATION_EMAIL_KIND,
    refId: inv.id,
    to: inv.email,
    toName: inv.contactName,
    subject: `Your invitation to the CIS × Dragnet benchmark — ${firmName}`,
    heading: `${firmName} is invited to the CIS × Dragnet benchmark`,
    paragraphs: [
      greeting,
      `${firmName} is invited to take part in the Capital-market Investor Service benchmark, run by the Chartered Institute of Stockbrokers with Dragnet Solutions Limited. It measures how stockbroking firms serve their investors, and each taking part receives its own confidential results.`,
      `Open the link below to set up your firm's space. You will be its coordinator: you give your name and mobile number and choose a 6-digit PIN, which you then use with your email address to sign in. You can add colleagues from inside.`,
      `This link is personal to your firm — please do not forward it. It expires on ${formatDate(inv.expiresAt)}.`,
    ],
    action: { label: "Set up your firm's space", url: link },
    footer:
      'If you were not expecting this, or someone else at your firm should coordinate, reply to this email and the CIS team will help.',
  });
}

/**
 * Invite a firm by email. If an open invitation for the same firm and address
 * exists, it is sent again (fresh expiry) rather than duplicated.
 */
export async function inviteFirm(
  pool: Pool,
  rbac: RbacContext,
  input: {
    organizationId: string;
    editionId?: string | null;
    email: string;
    contactName?: string | null;
  },
  ctx: InviteContext,
): Promise<{ invitation: FirmInvitationView; resent: boolean }> {
  requirePermission(rbac, SEND_PERMISSION);
  const email = input.email.trim();
  if (!emailOk(email)) {
    throw new FirmInvitationError('Enter a valid email address', 'EMAIL_INVALID');
  }
  const org = await assertInvitableFirm(pool, input.organizationId);
  await assertNotClaimed(pool, org.id);
  if (input.editionId) {
    const edition = await getEditionById(pool, input.editionId);
    if (!edition) throw new FirmInvitationError('That edition was not found', 'EDITION_NOT_FOUND');
  }

  const existing = await getPendingFirmInvitation(pool, org.id, email);
  if (existing) {
    const invitation = await sendInvitationAgain(pool, rbac, existing.id, ctx);
    return { invitation, resent: true };
  }

  const contactName = input.contactName?.trim() || null;
  let created: FirmInvitation;
  try {
    created = await withTransaction(pool, async (client) => {
      const c = client as unknown as Pool;
      const inv = await createFirmInvitation(c, {
        organizationId: org.id,
        editionId: input.editionId ?? null,
        email,
        contactName,
        expiresAt: newExpiry(),
        invitedBy: rbac.userId,
      });
      await queueInvitationEmail(c, inv, org.displayName, ctx.portalUrl);
      await writeAudit(c, {
        actorId: rbac.userId,
        actionType: 'firm_invitation.sent',
        entityType: 'firm_invitation',
        entityId: inv.id,
        editionId: inv.editionId,
        newValue: {
          organizationId: org.id,
          email,
          contactName,
          expiresAt: inv.expiresAt.toISOString(),
        },
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      });
      return inv;
    });
  } catch (err) {
    // Another operator invited the same address a moment ago: send that one.
    if ((err as { code?: string }).code === '23505') {
      const raced = await getPendingFirmInvitation(pool, org.id, email);
      if (raced) {
        const invitation = await sendInvitationAgain(pool, rbac, raced.id, ctx);
        return { invitation, resent: true };
      }
    }
    throw err;
  }
  const invitation = await toView(pool, { ...created, firmName: org.displayName });
  return { invitation, resent: false };
}

/**
 * Send a pending invitation again: same link, fresh expiry. (Not called
 * "resend": the domain surface deliberately has no resend — bounced batch
 * invitations are never resent, UX-OPS-002 — and a test guards that.)
 */
export async function sendInvitationAgain(
  pool: Pool,
  rbac: RbacContext,
  invitationId: string,
  ctx: InviteContext,
): Promise<FirmInvitationView> {
  requirePermission(rbac, SEND_PERMISSION);
  const inv = await getFirmInvitationById(pool, invitationId);
  if (!inv) throw new FirmInvitationError('That invitation was not found', 'NOT_FOUND');
  if (inv.status !== 'pending') {
    throw new FirmInvitationError(
      inv.status === 'accepted'
        ? 'That invitation has already been used to set up the firm’s space'
        : 'That invitation was revoked. Send a new one instead.',
      'NOT_PENDING',
    );
  }
  const org = await assertInvitableFirm(pool, inv.organizationId);
  await assertNotClaimed(pool, org.id);

  const updated = await withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const next = await markFirmInvitationSent(c, inv.id, newExpiry());
    await queueInvitationEmail(c, next, org.displayName, ctx.portalUrl);
    await writeAudit(c, {
      actorId: rbac.userId,
      actionType: 'firm_invitation.resent',
      entityType: 'firm_invitation',
      entityId: inv.id,
      editionId: inv.editionId,
      oldValue: { expiresAt: inv.expiresAt.toISOString(), sendCount: inv.sendCount },
      newValue: { expiresAt: next.expiresAt.toISOString(), sendCount: next.sendCount },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return next;
  });
  return toView(pool, { ...updated, firmName: org.displayName });
}

/** Revoke a pending invitation: its link stops working straight away. */
export async function revokeInvitation(
  pool: Pool,
  rbac: RbacContext,
  invitationId: string,
  ctx: Omit<InviteContext, 'portalUrl'> = {},
): Promise<FirmInvitationView> {
  requirePermission(rbac, SEND_PERMISSION);
  const inv = await getFirmInvitationById(pool, invitationId);
  if (!inv) throw new FirmInvitationError('That invitation was not found', 'NOT_FOUND');
  const org = await getOrganizationById(pool, inv.organizationId);

  const revoked = await withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const next = await dbRevokeFirmInvitation(c, inv.id);
    if (!next) {
      throw new FirmInvitationError(
        inv.status === 'accepted'
          ? 'That invitation has already been used, so it cannot be revoked'
          : 'That invitation is already revoked',
        'NOT_PENDING',
      );
    }
    await writeAudit(c, {
      actorId: rbac.userId,
      actionType: 'firm_invitation.revoked',
      entityType: 'firm_invitation',
      entityId: inv.id,
      editionId: inv.editionId,
      oldValue: { status: inv.status },
      newValue: { status: 'revoked' },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return next;
  });
  return toView(pool, { ...revoked, firmName: org?.displayName ?? '' });
}

/** A firm's invitations (or an edition's), newest first, with email delivery. */
export async function listInvitations(
  pool: Pool,
  rbac: RbacContext,
  scope: { organizationId: string } | { editionId: string },
): Promise<FirmInvitationView[]> {
  requirePermission(rbac, SEND_PERMISSION);
  const rows =
    'organizationId' in scope
      ? await listFirmInvitationsForOrganization(pool, scope.organizationId)
      : await listFirmInvitationsForEdition(pool, scope.editionId);
  return toViews(pool, rows);
}

/** Whether the firm already has a space (a claim or an active lead coordinator). */
export async function isFirmClaimed(pool: Pool, organizationId: string): Promise<boolean> {
  const claim = await getFirmClaim(pool, organizationId);
  if (claim) return true;
  return !!(await getActiveLead(pool, organizationId));
}

async function toView(pool: Pool, row: FirmInvitationWithFirm): Promise<FirmInvitationView> {
  const [view] = await toViews(pool, [row]);
  if (!view) throw new Error('firm invitation view is missing');
  return view;
}

async function toViews(
  pool: Pool,
  rows: FirmInvitationWithFirm[],
  now = new Date(),
): Promise<FirmInvitationView[]> {
  const emails = await listEmailsFor(
    pool,
    FIRM_INVITATION_EMAIL_KIND,
    rows.map((r) => r.id),
  );
  // listEmailsFor is oldest first, so the last one seen per invitation wins.
  const latest = new Map<string, FirmInvitationDelivery>();
  for (const e of emails) {
    if (!e.refId) continue;
    latest.set(e.refId, { status: e.status, error: e.error, at: e.attemptedAt ?? e.createdAt });
  }
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    firmName: r.firmName,
    editionId: r.editionId,
    email: r.email,
    contactName: r.contactName,
    state: invitationState(r, now),
    createdAt: r.createdAt,
    lastSentAt: r.lastSentAt,
    sendCount: r.sendCount,
    expiresAt: r.expiresAt,
    acceptedAt: r.acceptedAt,
    revokedAt: r.revokedAt,
    delivery: latest.get(r.id) ?? null,
  }));
}

const ASK_AGAIN = 'Ask the CIS team for a new invitation.';

/** Throws the friendly error for an invitation that cannot be used. */
export function assertUsableInvitation(
  inv: FirmInvitation | null,
  now = new Date(),
): asserts inv is FirmInvitation {
  if (!inv) {
    throw new FirmInvitationError(
      `This invitation link is not recognised. Check you opened the whole link from the email, or ask the CIS team for a new invitation.`,
      'NOT_FOUND',
    );
  }
  const state = invitationState(inv, now);
  if (state === 'accepted') {
    throw new FirmInvitationError(
      `This invitation has already been used to set up the firm’s space. Sign in with your email address and PIN, or ask the CIS team for a new invitation.`,
      'USED',
    );
  }
  if (state === 'revoked') {
    throw new FirmInvitationError(`This invitation was withdrawn. ${ASK_AGAIN}`, 'REVOKED');
  }
  if (state === 'expired') {
    throw new FirmInvitationError(`This invitation has expired. ${ASK_AGAIN}`, 'EXPIRED');
  }
}

/** Public: what an invitation link is for, or why it cannot be used. */
export async function lookupInvitation(pool: Pool, token: string): Promise<InvitationLookup> {
  const inv = await getFirmInvitationByToken(pool, token.trim());
  assertUsableInvitation(inv);
  if (await isFirmClaimed(pool, inv.organizationId)) {
    throw new FirmInvitationError(
      'This firm has already set up its space. Sign in with your email address and PIN, or ask the CIS team for a new invitation.',
      'USED',
    );
  }
  return {
    organizationId: inv.organizationId,
    firmName: inv.firmName,
    email: inv.email,
    contactName: inv.contactName,
    expiresAt: inv.expiresAt,
  };
}
