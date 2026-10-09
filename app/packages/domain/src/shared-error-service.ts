/**
 * UX-X-001 — Shared error, access and permission states.
 *
 * One shared recovery grammar for participant and organiser journeys — five
 * states, one shared component (the React side lives at
 * apps/admin/src/shared/ErrorState.tsx), used consistently instead of each
 * surface inventing its own copy. Wording here is a direct, deliberate
 * hardcode of the approved artefact's own text (the artefact itself hardcodes
 * these five short messages) — unlike UX-X-002, this is NOT routed through
 * Phase 15's managed-content system.
 *
 * Hard safety constraint: no state exposes respondent answers, identities or
 * confidential firm data. Every copy string below is state-only — none takes
 * a respondent id, name, or answer fragment as input.
 *
 * Withdrawal (§5 gap): "Participation closed or withdrawn" implies a genuine
 * withdrawal concept, distinct from Phase 17's `reminders_opted_out` (which
 * Phase 17 explicitly said is NOT withdrawal). This file adds the minimal
 * missing piece — the flag and the check — with NO self-service withdrawal
 * request/approval flow. That flow remains unspecified and out of scope; see
 * the README for the deliberate scope boundary.
 */

import { Pool } from 'pg';
import { markRespondentWithdrawn } from '@cis/db';
import { DomainError } from './errors';

/** Raised when a withdrawn respondent's own mutation attempts to continue
 *  their response (save an answer, submit). Maps to the shared
 *  'participation_closed' error state at the API layer. */
export class ParticipationClosedError extends DomainError {
  constructor() {
    super('This survey is no longer accepting responses.', 'PARTICIPATION_CLOSED');
  }
}

export const ERROR_STATES = [
  'expired_link',
  'no_unfinished_survey',
  'access_denied',
  'service_unavailable',
  'participation_closed',
] as const;

export type ErrorStateKind = (typeof ERROR_STATES)[number];

export interface ErrorStateCopy {
  title: string;
  detail: string;
}

export const ERROR_STATE_COPY: Readonly<Record<ErrorStateKind, ErrorStateCopy>> = {
  expired_link: {
    title: 'Expired continuation link',
    detail: 'This link has expired. Request a new continuation link to resume safely.',
  },
  no_unfinished_survey: {
    title: 'No unfinished survey found',
    detail: 'There is no unfinished response associated with this link.',
  },
  access_denied: {
    title: 'Access denied',
    detail: 'You do not have permission to open this area.',
  },
  service_unavailable: {
    title: 'Service temporarily unavailable',
    detail: 'The service is temporarily unavailable. Your saved work is not lost.',
  },
  participation_closed: {
    title: 'Participation closed or withdrawn',
    detail: 'This survey is no longer accepting responses.',
  },
};

/** Look up the shared copy for a state — the single source both the API and
 *  the UI can reach for, so no surface invents its own wording. */
export function getErrorStateCopy(kind: ErrorStateKind): ErrorStateCopy {
  return ERROR_STATE_COPY[kind];
}

/**
 * Mark a respondent genuinely withdrawn. This is the ENTIRE withdrawal
 * mechanism built in this phase — the flag, and (via the resume/continue
 * routes checking `respondent.withdrawnAt`) the check. It does not send a
 * request, require approval, or expose any self-service UI; it is an
 * operator action only. Deliberately minimal — see README.
 */
export async function withdrawRespondent(pool: Pool, respondentId: string): Promise<void> {
  await markRespondentWithdrawn(pool, respondentId);
}
