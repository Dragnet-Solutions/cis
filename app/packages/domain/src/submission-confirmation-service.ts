import type { Pool, PoolClient } from 'pg';
import {
  getActiveLead,
  getEditionById,
  getOrganizationById,
  getRegulatorEngagementByRespondent,
  getSeatByRespondentId,
  getSeatProgress,
  listActiveCoordinators,
  listEmailsFor,
  optOutOfReportByRecoveryToken,
  setSeatState,
} from '@cis/db';
import type { Edition, Respondent } from '@cis/shared-types';
import { queueNotice, queueTemplate } from './email-content';
import { fmtDateTime, seatSurveyName } from './email-fields';
import { siteOrigin } from './notice-links';
import { STUDY_NAME } from '@cis/survey';

/**
 * D-02 — every submission is confirmed by email when an address is known, and
 * says what happens next. Queued inside the submission's own transaction, so a
 * rolled-back submission sends nothing and a committed one always has its
 * notice. Never carries an answer, a score or a question's text.
 *
 * - An investor (retail S4, institutional S5a / S5b): thanks, which report
 *   they will get and how (their report-delivery choice), when (from the
 *   edition's own dates — never invented), and a link to opt out.
 * - A firm seat holder (S1 / S2 / S3): which survey was received for which
 *   firm; the firm's lead coordinator gets a separate progress notice
 *   ("2 of 3 surveys complete").
 * - A market institution (I-*): thanks, and that the institution approves its
 *   attributed passage before release — unless its Q0 answer closed the
 *   survey, when it is thanked and nothing is promised.
 */

/** Outbox kind of the respondent's confirmation; ref_id is the respondent. */
export const SUBMISSION_CONFIRMATION_EMAIL_KIND = 'submission-confirmation';
/** Outbox kind of the coordinator's seat-progress notice; ref_id is the
 *  submitting seat's respondent. */
export const FIRM_SEAT_PROGRESS_EMAIL_KIND = 'firm-seat-progress';

/** Opts a respondent out of the report (and further contact about the
 *  survey); the survey app handles ?noReport=. */
export const reportOptOutLink = (portalUrl: string | null | undefined, recoveryToken: string) =>
  `${siteOrigin(portalUrl)}/survey?noReport=${encodeURIComponent(recoveryToken)}`;

function emailOk(v: string | null | undefined): v is string {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A date as people read it in Lagos, e.g. "15 November 2026". */
function longDate(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  }).format(d);
}

const editionName = (edition: Edition | null) =>
  edition ? `${STUDY_NAME} ${edition.label}` : STUDY_NAME;

/**
 * When the report can be expected, from the edition's own data only. A
 * published report says so; otherwise the survey's closing date (if set)
 * anchors it; otherwise no date is given.
 */
function reportTiming(edition: Edition | null): string {
  if (edition?.resultsPublishedAt) {
    return `The results were published on ${longDate(edition.resultsPublishedAt)}.`;
  }
  if (edition?.surveyCloseAt) {
    return `The survey closes on ${longDate(edition.surveyCloseAt)}; the report follows once the results have been analysed and approved for release.`;
  }
  return 'The report follows once the survey has closed and the results have been analysed and approved for release.';
}

/** P-04's "On publication, expected …", from the edition's own dates only. */
function publishExpectation(edition: Edition | null): string {
  if (edition?.resultsPublishedAt) return `now (published ${longDate(edition.resultsPublishedAt)})`;
  if (edition?.surveyCloseAt) {
    return `after the survey closes on ${longDate(edition.surveyCloseAt)} and the results are approved`;
  }
  return 'once the survey has closed and the results are approved';
}

interface ConfirmationContext {
  db: PoolClient | Pool;
  respondent: Respondent;
  closedByScopeGate: boolean;
  portalUrl?: string | undefined;
}

/**
 * Queue the confirmation (and, for a firm seat, the coordinator's progress
 * notice) for a submission. Idempotent: a respondent who already has a
 * confirmation queued gets no second one. Returns how many notices it queued.
 */
export async function queueSubmissionConfirmation(
  db: PoolClient | Pool,
  respondent: Respondent,
  opts: { closedByScopeGate?: boolean; portalUrl?: string | undefined } = {},
): Promise<number> {
  const existing = await listEmailsFor(db, SUBMISSION_CONFIRMATION_EMAIL_KIND, [respondent.id]);
  const existingProgress = await listEmailsFor(db, FIRM_SEAT_PROGRESS_EMAIL_KIND, [respondent.id]);
  if (existing.length > 0 || existingProgress.length > 0) return 0;

  const ctx: ConfirmationContext = {
    db,
    respondent,
    closedByScopeGate: opts.closedByScopeGate ?? false,
    portalUrl: opts.portalUrl,
  };
  const pool = db as Pool;

  const seat = await getSeatByRespondentId(pool, respondent.id);
  if (seat) return queueFirmSeat(ctx, seat);

  const engagement = await getRegulatorEngagementByRespondent(pool, respondent.id);
  if (engagement) return queueMarketInstitution(ctx, engagement);

  return queueInvestor(ctx);
}

// ─── Investors (retail, institutional) ─────────────────────────────────────────

async function queueInvestor(ctx: ConfirmationContext): Promise<number> {
  const { respondent } = ctx;
  const to = respondent.contactEmail;
  if (!emailOk(to)) return 0;
  const edition = await getEditionById(ctx.db as Pool, respondent.editionId);

  const delivery = respondent.reportDelivery;
  const reportLine =
    delivery === 'email' || delivery === 'both'
      ? `What happens next: you asked for the final report by email, so we will send the ${STUDY_NAME} Industry report to this address when it is published.`
      : delivery === 'text'
        ? `What happens next: you asked for the final report by text message, so we will send the ${STUDY_NAME} Industry report to your mobile number when it is published.`
        : 'What happens next: you chose not to receive the final report, so we will not send it to you.';
  const wantsReport = delivery === 'email' || delivery === 'both' || delivery === 'text';

  const who = respondent.institutionName ? ` on behalf of ${respondent.institutionName}` : '';
  const paragraphs = [
    `Thank you for taking part in the ${editionName(edition)} survey${who}. Your answers are in, and they are now final.`,
    reportLine,
    ...(wantsReport ? [reportTiming(edition)] : []),
    'Your answers are never shown to the firms you rated, and your name and contact details are never published.',
  ];

  const footer =
    wantsReport && respondent.recoveryToken
      ? `You are receiving this because you gave this address in the survey. If you would rather not receive the report or hear from us again about this survey, opt out here: ${reportOptOutLink(ctx.portalUrl, respondent.recoveryToken)}`
      : 'You are receiving this because you gave this address in the survey. We will not contact you again about it.';

  // P-04 promises the report to this address, so it fits only an email
  // delivery; a text or no-report choice keeps its own wording in the shared
  // layout.
  if ((delivery === 'email' || delivery === 'both') && respondent.recoveryToken) {
    await queueTemplate(ctx.db, {
      kind: SUBMISSION_CONFIRMATION_EMAIL_KIND,
      refId: respondent.id,
      to: to.trim(),
      template: 'P-04',
      fields: {
        publish_date: publishExpectation(edition),
        optout_url: reportOptOutLink(ctx.portalUrl, respondent.recoveryToken),
        institution: respondent.institutionName?.trim() || null,
        edition: edition?.label,
      },
    });
    return 1;
  }
  await queueNotice(ctx.db, {
    kind: SUBMISSION_CONFIRMATION_EMAIL_KIND,
    refId: respondent.id,
    to: to.trim(),
    audience: 'investor',
    subject: 'Thank you for taking part',
    label: 'Thank you',
    heading: 'Thank you. Your answers are in.',
    paragraphs,
    footer,
  });
  return 1;
}

// ─── Firm seats (S1, S2, S3) ─────────────────────────────────────────────────

type Seat = NonNullable<Awaited<ReturnType<typeof getSeatByRespondentId>>>;

async function queueFirmSeat(ctx: ConfirmationContext, seat: Seat): Promise<number> {
  const pool = ctx.db as Pool;
  const { respondent } = ctx;
  // The seat is complete as of this submission — in the same transaction, so
  // the firm's progress can never disagree with the survey.
  if (seat.state !== 'complete') {
    await setSeatState(pool, {
      editionId: seat.editionId,
      organizationId: seat.organizationId,
      seatCode: seat.seatCode,
      state: 'complete',
    });
  }
  const firmName =
    (await getOrganizationById(pool, seat.organizationId))?.displayName ?? 'Your firm';
  const progress = await getSeatProgress(pool, seat.editionId, seat.organizationId);
  const coordinator =
    (await getActiveLead(pool, seat.organizationId)) ??
    (await listActiveCoordinators(pool, seat.organizationId))[0] ??
    null;
  const to = emailOk(seat.assignedEmail)
    ? seat.assignedEmail
    : emailOk(respondent.contactEmail)
      ? respondent.contactEmail
      : null;
  const coordinatorIsRespondent =
    to !== null && coordinator !== null && sameAddress(coordinator.email, to);

  // F-08 to the respondent, and the same email to the coordinator ("with the
  // coordinator copied") — once, when the coordinator answered it themselves.
  const fields = {
    respondent_name: seat.assignedName?.trim() || 'colleague',
    firm: firmName,
    survey_name: seatSurveyName(seat),
    submitted_at: fmtDateTime(new Date()),
    surveys_done: progress.complete,
    edition: (await getEditionById(pool, seat.editionId))?.label,
  };
  let queued = 0;
  if (to) {
    await queueTemplate(ctx.db, {
      kind: SUBMISSION_CONFIRMATION_EMAIL_KIND,
      refId: respondent.id,
      to: to.trim(),
      toName: seat.assignedName,
      template: 'F-08',
      fields,
    });
    queued += 1;
  }

  if (coordinator && emailOk(coordinator.email) && !coordinatorIsRespondent) {
    await queueTemplate(ctx.db, {
      kind: FIRM_SEAT_PROGRESS_EMAIL_KIND,
      refId: respondent.id,
      to: coordinator.email.trim(),
      toName: coordinator.name,
      template: 'F-08',
      // Only the coordinator's copy says which surveys are still to come.
      fields: {
        ...fields,
        still_to_come: progress.outstandingSeats.map(seatSurveyName).join(', ') || null,
      },
    });
    queued += 1;
  }
  return queued;
}

// ─── Market institutions (I-*) ─────────────────────────────────────────────────

type Engagement = NonNullable<Awaited<ReturnType<typeof getRegulatorEngagementByRespondent>>>;

async function queueMarketInstitution(
  ctx: ConfirmationContext,
  engagement: Engagement,
): Promise<number> {
  const to = engagement.contact?.email;
  if (!emailOk(to)) return 0;
  const institution = engagement.institutionName;
  const edition = await getEditionById(ctx.db as Pool, ctx.respondent.editionId);
  // A closing Q0 is a complete response: thanked (I-04), never framed as a
  // refusal, and nothing is promised about a published reading.
  await queueTemplate(ctx.db, {
    kind: SUBMISSION_CONFIRMATION_EMAIL_KIND,
    refId: ctx.respondent.id,
    to: to.trim(),
    toName: engagement.contact?.who ?? null,
    template: ctx.closedByScopeGate ? 'I-04' : 'I-03',
    fields: {
      contact_name: engagement.contact?.who?.trim() || institution,
      institution,
      submitted_at: fmtDateTime(new Date()),
      edition: edition?.label,
    },
  });
  return 1;
}

// ─── Opt-out ──────────────────────────────────────────────────────────────────

/**
 * The confirmation's opt-out link: no report, and no further contact about
 * the survey. Answers and participation are untouched. Returns whether the
 * token matched a respondent.
 */
export async function optOutOfReport(pool: Pool, recoveryToken: string): Promise<boolean> {
  return optOutOfReportByRecoveryToken(pool, recoveryToken);
}
