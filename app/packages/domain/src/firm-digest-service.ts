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
 * Delivery reuses Phase 9's SendingService — no second sending mechanism.
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
} from './invitations-service';
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
  deliveryState: 'sent' | 'bounced';
  recipientEmail: string;
}

/**
 * Assemble and push a digest to the firm's lead coordinator, via their
 * already-validated contact channel (Phase 4's required, length-validated
 * mobile number, or email). Delivery goes through the caller-supplied
 * SendingService — this function never performs its own I/O.
 */
export async function sendFirmDigest(
  pool: Pool,
  editionId: string,
  organizationId: string,
  sendingService?: SendingService,
): Promise<FirmDigestSendResult> {
  const digest = await assembleFirmDigest(pool, editionId, organizationId);
  const lead = await getActiveLead(pool, organizationId);
  if (!lead) {
    throw new FirmDigestError(
      'No active lead coordinator to deliver the digest to',
      'NO_COORDINATOR',
    );
  }
  // Zeptomail is the resolved provider (Phase 10); it degrades to
  // recording-only when no token is configured, matching Phase 9's sendBatch.
  const service = sendingService ?? new ZeptomailSendingService();
  const result = await service.send({
    recipientEmail: lead.email,
    firmName: digest.firmName,
    organizationId,
    code: null,
  });
  return { digest, deliveryState: result.deliveryState, recipientEmail: lead.email };
}
