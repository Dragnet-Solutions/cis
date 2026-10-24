import { describe, it, expect } from 'vitest';
import type { FirmInvitation } from '../api/types';
import {
  deliveryLabel,
  filterInvitations,
  hasQueuedDelivery,
  summarizeInvitations,
  summaryLine,
} from './firmInvitationsModel';

function inv(
  id: string,
  state: FirmInvitation['state'],
  delivery: FirmInvitation['delivery'] = null,
): FirmInvitation {
  return {
    id,
    organizationId: `org-${id}`,
    firmName: `Firm ${id}`,
    editionId: 'ed',
    email: `${id}@firm.example`,
    contactName: null,
    state,
    createdAt: '2026-10-01T00:00:00Z',
    lastSentAt: '2026-10-01T00:00:00Z',
    sendCount: 1,
    expiresAt: '2026-10-15T00:00:00Z',
    acceptedAt: null,
    revokedAt: null,
    delivery,
  };
}

const failed = { status: 'failed' as const, error: 'bounced', at: '2026-10-01T00:00:00Z' };
const sent = { status: 'sent' as const, error: null, at: '2026-10-01T00:00:00Z' };

const LIST = [
  inv('a', 'pending', sent),
  inv('b', 'pending', failed),
  inv('c', 'accepted', sent),
  inv('d', 'expired', failed),
  inv('e', 'revoked'),
];

describe('firm invitations model', () => {
  it('counts each state and failed emails separately', () => {
    expect(summarizeInvitations(LIST)).toEqual({
      pending: 2,
      accepted: 1,
      expired: 1,
      revoked: 1,
      failed: 2,
    });
  });

  it('writes the summary line', () => {
    expect(summaryLine(summarizeInvitations(LIST))).toBe(
      '2 pending · 1 accepted · 1 expired · 1 revoked · 2 failed emails',
    );
    expect(summaryLine(summarizeInvitations([inv('x', 'pending', failed)]))).toBe(
      '1 pending · 0 accepted · 0 expired · 0 revoked · 1 failed email',
    );
    expect(summaryLine(summarizeInvitations([]))).toBe(
      '0 pending · 0 accepted · 0 expired · 0 revoked · 0 failed emails',
    );
  });

  it('filters by state or by failed email', () => {
    expect(filterInvitations(LIST, 'all')).toHaveLength(5);
    expect(filterInvitations(LIST, 'pending').map((i) => i.id)).toEqual(['a', 'b']);
    expect(filterInvitations(LIST, 'revoked').map((i) => i.id)).toEqual(['e']);
    expect(filterInvitations(LIST, 'failed').map((i) => i.id)).toEqual(['b', 'd']);
  });

  it('describes delivery in plain words', () => {
    expect(deliveryLabel(null).text).toBe('—');
    expect(deliveryLabel(sent)).toEqual({ text: 'Accepted', cls: 'tag ok' });
    expect(deliveryLabel(failed)).toEqual({ text: 'Failed: bounced', cls: 'tag risk' });
    expect(deliveryLabel({ status: 'queued', error: null, at: '' }).text).toBe('Queued');
    expect(deliveryLabel({ status: 'logged', error: null, at: '' }).text).toBe(
      'Not sent — no mail service',
    );
  });
});

// D-25: while an email is queued the page re-reads both invitation tables
// together, so one never says "Queued" while the other says "Accepted".
describe('hasQueuedDelivery', () => {
  const queued = { status: 'queued' as const, error: null, at: '2026-10-01T00:00:00Z' };
  it('is true while any email waits on the mail service', () => {
    expect(hasQueuedDelivery([inv('a', 'pending', sent), inv('b', 'pending', queued)])).toBe(true);
  });
  it('is false once every email is accepted, logged or failed (or none was sent)', () => {
    expect(hasQueuedDelivery([inv('a', 'pending', sent), inv('b', 'pending', failed)])).toBe(false);
    expect(hasQueuedDelivery([inv('c', 'accepted')])).toBe(false);
  });
});
