import type { Pool, PoolClient } from 'pg';
import { getUserById, listCriticalActionApprovers } from '@cis/db';
import { queueTemplate } from './email-content';
import { emailOrigin } from './email-templates';
import { fmtDateTime } from './email-fields';

/**
 * Maker-checker emails. When someone requests a critical action, everyone who
 * may approve it — except the requester — is asked to decide (O-03). When it
 * is approved or declined, the requester is told (O-04). Queued with the
 * request or the decision, in its transaction when it has one.
 */

/** Outbox kinds; ref_id is the critical action (or scoring sign-off). */
export const APPROVAL_REQUESTED_EMAIL_KIND = 'approval-requested';
export const APPROVAL_OUTCOME_EMAIL_KIND = 'approval-outcome';

/** The scoring sign-off is maker-checker on its own table, not critical_actions. */
export const SCORING_SIGNOFF_ACTION = 'scoring_signoff';

/** What each action is called in the emails, and the operations page that decides it. */
const ACTIONS: Readonly<Record<string, { label: string; tab: string }>> = {
  instrument_freeze: { label: 'Freeze the survey instruments', tab: 'surveys' },
  'edition:lock': { label: 'Lock the results', tab: 'edition' },
  scoring_methodology_approval: { label: 'Approve the scoring methodology', tab: 'scoring' },
  [SCORING_SIGNOFF_ACTION]: { label: 'Sign off the scores', tab: 'scoring' },
  national_report_approval: { label: 'Approve the national report', tab: 'national' },
  firm_report_release: { label: 'Release the firm reports', tab: 'firmreports' },
};

function actionOf(actionType: string): { label: string; tab: string } {
  return ACTIONS[actionType] ?? { label: actionType.replace(/[_:]/g, ' '), tab: 'edition' };
}

/** Where an action is decided: the operations site's page for it. */
export const approvalUrl = (actionType: string): string =>
  `${emailOrigin()}/?tab=${encodeURIComponent(actionOf(actionType).tab)}`;

type Db = Pool | PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUserId = (id: string | null | undefined): id is string => !!id && UUID_RE.test(id);

async function nameOf(db: Db, userId: string | null): Promise<string> {
  if (!isUserId(userId)) return 'A colleague';
  return (await getUserById(db as Pool, userId))?.displayName ?? 'A colleague';
}

/** O-03 to every approver of `actionType` except the requester. Returns how many. */
export async function notifyApprovalRequested(
  db: Db,
  input: { actionType: string; refId: string; requestedBy: string; requestedAt?: Date },
): Promise<number> {
  const approvers = await listCriticalActionApprovers(
    db as Pool,
    input.actionType,
    input.requestedBy,
  );
  if (approvers.length === 0) return 0;
  const requestedBy = await nameOf(db, input.requestedBy);
  const fields = {
    action: actionOf(input.actionType).label,
    requested_by: requestedBy,
    requested_at: fmtDateTime(input.requestedAt ?? new Date()),
    approval_url: approvalUrl(input.actionType),
  };
  for (const a of approvers) {
    await queueTemplate(db, {
      kind: APPROVAL_REQUESTED_EMAIL_KIND,
      refId: input.refId,
      to: a.email,
      toName: a.displayName,
      template: 'O-03',
      fields,
    });
  }
  return approvers.length;
}

/** O-04 to the requester: their request was approved or declined. */
export async function notifyApprovalDecided(
  db: Db,
  input: {
    actionType: string;
    refId: string;
    requestedBy: string;
    decidedBy: string;
    approved: boolean;
    reason?: string | null;
    decidedAt?: Date;
  },
): Promise<void> {
  if (!isUserId(input.requestedBy)) return;
  const requester = await getUserById(db as Pool, input.requestedBy);
  if (!requester?.isActive || !requester.email) return;
  const outcome = input.approved ? 'Approved' : 'Declined';
  await queueTemplate(db, {
    kind: APPROVAL_OUTCOME_EMAIL_KIND,
    refId: input.refId,
    to: requester.email,
    toName: requester.displayName,
    template: 'O-04',
    fields: {
      action: actionOf(input.actionType).label,
      outcome,
      outcome_lower: outcome.toLowerCase(),
      approver: await nameOf(db, input.decidedBy),
      reason: input.reason?.trim() || (input.approved ? 'None given' : 'No reason given'),
      decided_at: fmtDateTime(input.decidedAt ?? new Date()),
      ops_url: approvalUrl(input.actionType),
    },
  });
}
