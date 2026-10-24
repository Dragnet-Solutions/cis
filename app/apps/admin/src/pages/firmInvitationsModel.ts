import type { FirmInvitation, FirmInvitationState } from '../api/types';

/** How each invitation state is shown. */
export const INVITE_STATE: Record<FirmInvitationState, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'tag wait' },
  accepted: { label: 'Accepted', cls: 'tag ok' },
  expired: { label: 'Expired', cls: 'tag soft' },
  revoked: { label: 'Revoked', cls: 'tag soft' },
};

/** How the latest invitation email fared, in plain words. */
export function deliveryLabel(d: FirmInvitation['delivery']): { text: string; cls: string } {
  if (!d) return { text: '—', cls: '' };
  switch (d.status) {
    case 'sent':
      // The mail service took it; ZeptoMail does not confirm inbox delivery.
      return { text: 'Accepted', cls: 'tag ok' };
    case 'logged':
      return { text: 'Not sent — no mail service', cls: 'tag soft' };
    case 'failed':
      return { text: `Failed: ${d.error ?? 'unknown reason'}`, cls: 'tag risk' };
    default:
      return { text: d.error ? `Queued — retrying (${d.error})` : 'Queued', cls: 'tag wait' };
  }
}

/**
 * Whether any invitation's email is still waiting on the mail service. Its
 * status changes on the server after the page has loaded (Queued → Accepted),
 * so while one is waiting the page re-reads BOTH invitation tables together —
 * they never show the same invitation in two different states (D-25).
 */
export function hasQueuedDelivery(invitations: FirmInvitation[]): boolean {
  return invitations.some(
    (i) => !!i.delivery && !['sent', 'logged', 'failed'].includes(i.delivery.status),
  );
}

/** How often, and at most how many times in a row, the page re-reads while an
 *  email is queued (a mail service that is down must not poll forever). */
export const QUEUED_POLL_MS = 5_000;
export const QUEUED_POLL_LIMIT = 12;

/** The edition-wide list's filter: one state, failed emails, or everything. */
export type InvitationFilter = 'all' | FirmInvitationState | 'failed';

export const INVITATION_FILTERS: Array<{ value: InvitationFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'failed', label: 'Failed emails' },
];

export interface InvitationSummary {
  pending: number;
  accepted: number;
  expired: number;
  revoked: number;
  /** Invitations whose latest email failed to send. */
  failed: number;
}

export function summarizeInvitations(invitations: FirmInvitation[]): InvitationSummary {
  const s: InvitationSummary = { pending: 0, accepted: 0, expired: 0, revoked: 0, failed: 0 };
  for (const inv of invitations) {
    s[inv.state] += 1;
    if (inv.delivery?.status === 'failed') s.failed += 1;
  }
  return s;
}

/** "3 pending · 1 accepted · 0 expired · 0 revoked · 1 failed email". */
export function summaryLine(s: InvitationSummary): string {
  return [
    `${s.pending} pending`,
    `${s.accepted} accepted`,
    `${s.expired} expired`,
    `${s.revoked} revoked`,
    `${s.failed} failed ${s.failed === 1 ? 'email' : 'emails'}`,
  ].join(' · ');
}

export function filterInvitations(
  invitations: FirmInvitation[],
  filter: InvitationFilter,
): FirmInvitation[] {
  if (filter === 'all') return invitations;
  if (filter === 'failed') return invitations.filter((i) => i.delivery?.status === 'failed');
  return invitations.filter((i) => i.state === filter);
}
