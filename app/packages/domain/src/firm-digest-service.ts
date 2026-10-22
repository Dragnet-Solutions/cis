/**
 * UX-FRM-DIG-001 — Firm digest.
 *
 * A periodic push summary of data the coordinator can already see in the
 * portal — never new information, and never respondent identity or
 * individual answers. Everything here is assembled from COUNTS and STATE
 * FLAGS already computed elsewhere:
 *   - seat completion:        Phase 4's seat-assignment state
 *   - investor contribution:  Phase 5's firm_id-attributable counts, by segment
 *   - what needs attention:   Phase 4/9's existing firm audience states
 *
 * Delivery reuses Phase 9's SendingService — no second sending mechanism —
 * which queues the digest in the email outbox for ZeptoMail.
 * Frequency and channel are governed config (the artefact is explicit that
 * these are implementation configuration, not a design decision).
 */

import { Pool } from 'pg';
import {
  getOrganizationById,
  getFirmSegmentContributionCounts,
  getActiveLead,
  getConfig,
  setConfig,
  type FirmSegmentContribution,
} from '@cis/db';
import { getSeats } from './firm-portal-service';
import {
  getFirmAudienceState,
  ZeptomailSendingService,
  type SendingService,
  type SendOutcome,
} from './invitations-service';
import { firmPortalLink } from './notice-links';
import { DomainError } from './errors';

export class FirmDigestError extends DomainError {
  constructor(message: string, code = 'FIRM_DIGEST') {
    super(message, code);
  }
}

export type FirmAttentionState = 'noassign' | 'partial' | 'noreach' | 'complete' | null;

const ATTENTION_LABEL: Record<Exclude<FirmAttentionState, null>, string> = {
  noassign: 'Outstanding seat assignments — nobody has been told who answers.',
  partial: 'At least one of the three firm surveys is still outstanding.',
  noreach: 'All three surveys are in, but no client outreach has been sent yet.',
  complete: 'No action required today.',
};

export interface FirmDigest {
  organizationId: string;
  firmName: string;
  seatCompletion: { complete: number; total: number };
  investorContribution: FirmSegmentContribution & { total: number };
  attention: { state: FirmAttentionState; label: string };
}

const DEFAULT_SCHEDULE = { frequency: 'monthly', channel: 'email' } as const;

export interface FirmDigestSchedule {
  frequency: string;
  channel: string;
}

export async function getFirmDigestSchedule(pool: Pool): Promise<FirmDigestSchedule> {
  return (await getConfig<FirmDigestSchedule>(pool, 'firm_digest.schedule')) ?? DEFAULT_SCHEDULE;
}

export async function setFirmDigestSchedule(
  pool: Pool,
  schedule: FirmDigestSchedule,
): Promise<void> {
  await setConfig(
    pool,
    'firm_digest.schedule',
    schedule,
    'Firm digest push frequency and delivery channel — implementation configuration.',
  );
}

/**
 * Assemble one firm's digest content. Every query this function calls returns
 * counts or state flags only — none joins to `responses` or `respondent_drafts`,
 * and none selects answer content or a respondent's identity. This is a
 * structural guarantee: there is no code path here through which individual
 * response content could be returned, whatever input is supplied.
 */
export async function assembleFirmDigest(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<FirmDigest> {
  const org = await getOrganizationById(pool, organizationId);
  if (!org) throw new FirmDigestError('Organization not found', 'ORG_NOT_FOUND');

  const [seats, contribution, audienceState] = await Promise.all([
    getSeats(pool, editionId, organizationId),
    getFirmSegmentContributionCounts(pool, editionId, organizationId),
    getFirmAudienceState(pool, editionId, organizationId),
  ]);

  const complete = seats.filter((s) => s.state === 'complete').length;
  const state: FirmAttentionState =
    audienceState ?? (seats.length > 0 && complete === seats.length ? 'complete' : null);

  return {
    organizationId,
    firmName: org.displayName,
    seatCompletion: { complete, total: seats.length },
    investorContribution: {
      ...contribution,
      total:
        contribution.retail + contribution.localInstitutional + contribution.foreignInstitutional,
    },
    attention: {
      state,
      label: state ? ATTENTION_LABEL[state] : 'No action required today.',
    },
  };
}

export interface FirmDigestSendResult {
  digest: FirmDigest;
  /** `sent`: queued for delivery; `not_sent`: the lead has no usable address. */
  deliveryState: SendOutcome;
  recipientEmail: string;
}

/** Outbox kind of a firm digest email; its ref_id is the firm (organization). */
export const FIRM_DIGEST_EMAIL_KIND = 'firm-digest';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The digest as email paragraphs — the same counts the portal shows. */
export function digestParagraphs(digest: FirmDigest, leadName: string | null): string[] {
  const c = digest.investorContribution;
  return [
    leadName?.trim() ? `Dear ${leadName.trim()},` : 'Hello,',
    `Here is where ${digest.firmName} stands in the CIS × Dragnet benchmark.`,
    `Firm surveys: ${digest.seatCompletion.complete} of ${digest.seatCompletion.total} complete.`,
    `Investors who answered through your firm's links: ${c.total} — ${plural(c.retail, 'retail investor')}, ${plural(c.localInstitutional, 'Nigerian institution')}, ${plural(c.foreignInstitutional, 'institution')} abroad.`,
    `What needs attention: ${digest.attention.label}`,
    'Sign in to the firm portal with your email address and PIN to see the detail.',
  ];
}

/**
 * Assemble and push a digest to the firm's lead coordinator by email. Delivery
 * goes through the SendingService (by default queued in the email outbox,
 * kind 'firm-digest', for ZeptoMail).
 */
export async function sendFirmDigest(
  pool: Pool,
  editionId: string,
  organizationId: string,
  sendingService?: SendingService,
  opts: { portalUrl?: string } = {},
): Promise<FirmDigestSendResult> {
  const digest = await assembleFirmDigest(pool, editionId, organizationId);
  const lead = await getActiveLead(pool, organizationId);
  if (!lead) {
    throw new FirmDigestError(
      'No active lead coordinator to deliver the digest to',
      'NO_COORDINATOR',
    );
  }
  const service = sendingService ?? new ZeptomailSendingService();
  const result = await service.send(
    {
      recipientEmail: lead.email,
      recipientName: lead.name,
      firmName: digest.firmName,
      organizationId,
      code: null,
      kind: FIRM_DIGEST_EMAIL_KIND,
      audience: 'firm',
      refId: organizationId,
      subject: `${digest.firmName}: your benchmark update`,
      heading: `${digest.firmName}: your benchmark update`,
      paragraphs: digestParagraphs(digest, lead.name),
      action: { label: 'Open the firm portal', url: firmPortalLink(opts.portalUrl) },
    },
    pool,
  );
  return { digest, deliveryState: result.deliveryState, recipientEmail: lead.email };
}
