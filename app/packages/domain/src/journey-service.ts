import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  getRespondentById,
  getRespondentByRecoveryToken,
  createRespondent,
  updateRespondentJourney,
  setRespondentContact,
  upsertDraft,
  listDraftsForRespondent,
  insertResponses,
  markRespondentSubmitted,
  getInstrumentItems,
  getActiveEditionParticipants,
  confirmEngagementForSubmittedRespondent,
  getConfig,
  getEditionStatus,
  withTransaction,
  listEmailsFor,
  isRespondentLinkInvalidated,
  listInstrumentDefinitions,
} from '@cis/db';
import {
  applyScopeGate,
  buildJourneySequence,
  closesScope,
  firmContextAt,
  isAnswered,
  requiresConsent,
  type AnswerValue,
  type SurveyItem,
  STUDY_NAME,
} from '@cis/survey';
import type { Respondent, RespondentDraft, Response } from '@cis/shared-types';
import { DomainError } from './errors';
import { ConsentRequiredError, ResponseScopeError } from './response-service';
import { emitCompletedForRespondent } from './funnel-service';
import { ParticipationClosedError } from './shared-error-service';
import { isRegulatorInstrument } from './institution-family-service';
import { queueNotice } from './email-content';
import { surveyResumeLink } from './notice-links';
import { queueSubmissionConfirmation } from './submission-confirmation-service';

/** Outbox kind of the save-and-resume email; ref_id is the respondent. */
export const SURVEY_RESUME_EMAIL_KIND = 'survey-resume-link';
/** At most this many resume emails per respondent — the contact route is
 *  public, so it must not become a way to mail an address repeatedly. */
const MAX_RESUME_EMAILS = 5;

/** A required contact-collecting surface was progressed without accepted consent. */
export { ConsentRequiredError };

/** A survey that was already submitted cannot be submitted again (answers are
 *  final and the confirmation has gone). The API answers 409 ALREADY_SUBMITTED. */
export class AlreadySubmittedError extends DomainError {
  constructor() {
    super('This survey has already been submitted. Your answers are saved.', 'ALREADY_SUBMITTED');
  }
}

export class ReviewGapError extends DomainError {
  constructor(
    public readonly outstanding: Array<{ questionId: string; ratedFirmId: string | null }>,
  ) {
    super('The survey has unanswered required items and cannot be submitted', 'REVIEW_GAP');
  }
}

/** The link was replaced (cancel and start again): it no longer works, and
 *  anything started on it was discarded (UX-INS-003 link_invalidated). */
export class LinkInvalidatedError extends DomainError {
  constructor() {
    super(
      'This link no longer works. The survey has been sent to someone else, and anything started on this link was discarded.',
      'LINK_INVALIDATED',
    );
  }
}

async function assertLinkValid(pool: Pool, respondentId: string): Promise<void> {
  if (await isRespondentLinkInvalidated(pool, respondentId)) throw new LinkInvalidatedError();
}

/** An answer to an item after a scope gate that has closed the instrument.
 *  The respondent reads the message, so it never names the question's ID
 *  (D-18); `questionId` keeps it for the server. */
export class ScopeClosedError extends DomainError {
  constructor(public readonly questionId: string) {
    super('This question is not part of this survey: an earlier answer closed it.', 'SCOPE_CLOSED');
  }
}

/** The edition's collection has ended (results locked or archived): no new
 *  journey may start and no answer may be saved or submitted, whatever the
 *  entry route. */
export class CollectionClosedError extends DomainError {
  constructor() {
    super('This study has closed and is no longer accepting responses.', 'COLLECTION_CLOSED');
  }
}

/** A regulator / market-infrastructure review was started without the
 *  named-contact link issued from the Regulators screen. */
export class RegulatorLinkRequiredError extends DomainError {
  constructor() {
    super(
      'This review can only be opened from the personal link sent to your institution.',
      'REGULATOR_LINK_REQUIRED',
    );
  }
}

/** Whether an edition status still accepts responses. A draft edition is left
 *  open to journeys (pre-launch checks and pilots run against it); only a
 *  locked or archived edition has ended collection. */
export function acceptsResponses(status: string | null): boolean {
  return status !== null && status !== 'locked' && status !== 'archived';
}

/** Refuse when the edition's collection has ended. With `forShare` (inside a
 *  transaction) the edition row is share-locked, so a lock approved at the
 *  same moment waits for this write to finish rather than racing past it. */
export async function assertCollectionOpen(
  pool: Pool,
  editionId: string,
  opts: { forShare?: boolean } = {},
): Promise<void> {
  const status = await getEditionStatus(pool, editionId, opts);
  if (!acceptsResponses(status)) throw new CollectionClosedError();
}

function emailOk(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function phoneOk(v: string): boolean {
  return /^\+?[0-9][0-9\s()-]{7,}$/.test(v);
}

/** Begin a journey: create the respondent record. `recruitingFirmId` is the
 *  source firm (retail firm-invite) — for referrals/colleague-invites it is left
 *  null so no source-firm attribution is inherited.
 *
 *  Every self-started entry route (public, outreach link, firm seat, referral,
 *  colleague invite) comes through here, so this is where a closed edition and
 *  a regulator review are refused. A regulator's own journey is created when
 *  its link is issued (`issueSurveyLink`), never here. */
export async function startJourney(
  pool: Pool,
  data: {
    editionId: string;
    instrumentCode: string;
    recruitingFirmId?: string | null;
    institutionName?: string | null;
    referredByRespondentId?: string | null;
  },
): Promise<Respondent> {
  if (await isRegulatorInstrument(pool, data.instrumentCode)) {
    throw new RegulatorLinkRequiredError();
  }
  await assertCollectionOpen(pool, data.editionId);
  return createRespondent(pool, {
    editionId: data.editionId,
    instrumentCode: data.instrumentCode,
    recruitingFirmId: data.recruitingFirmId ?? null,
    institutionName: data.institutionName ?? null,
    referredByRespondentId: data.referredByRespondentId ?? null,
  });
}

/** The consent wording a respondent sees (PAT-011). */
export interface PublicConsentContent {
  notice: string;
  expansionTitle: string;
  expansion: string;
  checkboxLabel: string;
}

/**
 * The governed consent copy, reduced to the four respondent-facing fields.
 * The stored config also carries governance notes for the study team (e.g.
 * that the wording is provisional and who owns it) — those are internal and
 * are never sent to the public page. An allow-list, so a note added to the
 * config later stays internal by default.
 */
export async function getPublicConsentContent(
  pool: Pool,
): Promise<{ consent: PublicConsentContent | null; recoveryTtlSeconds: number | null }> {
  const [stored, ttl] = await Promise.all([
    getConfig<Partial<Record<keyof PublicConsentContent, unknown>>>(pool, 'consent.pat011'),
    getConfig<number>(pool, 'recovery.link_ttl_seconds'),
  ]);
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const consent = stored
    ? {
        notice: text(stored.notice),
        expansionTitle: text(stored.expansionTitle),
        expansion: text(stored.expansion),
        checkboxLabel: text(stored.checkboxLabel),
      }
    : null;
  return { consent, recoveryTtlSeconds: ttl };
}

export interface ContactInput {
  consentAccepted: boolean;
  channel: 'email' | 'text' | 'both' | 'none';
  email?: string | null;
  phone?: string | null;
}

/**
 * Record consent + contact preference, enforcing PAT-011 ordering SERVER-SIDE:
 * consent gates the primary action and is required to proceed even when no
 * contact detail is given (answers are personal data regardless). A contact
 * field is only ever stored once consent is accepted. Returns the respondent
 * with a recovery token minted.
 */
export async function registerContact(
  pool: Pool,
  respondentId: string,
  input: ContactInput,
  opts: { portalUrl?: string } = {},
): Promise<Respondent> {
  const respondent = await getRespondentById(pool, respondentId);
  if (!respondent) throw new DomainError('Respondent not found', 'RESPONDENT_NOT_FOUND');
  await assertCollectionOpen(pool, respondent.editionId);

  // Notice → consent → field: consent must be accepted before any field is taken.
  if (!input.consentAccepted) {
    throw new ConsentRequiredError(respondent.instrumentCode);
  }

  if (input.channel === 'email' || input.channel === 'both') {
    if (!input.email || !emailOk(input.email)) {
      throw new ResponseScopeError('A valid email address is required for this channel');
    }
  }
  if (input.channel === 'text' || input.channel === 'both') {
    if (!input.phone || !phoneOk(input.phone)) {
      throw new ResponseScopeError('A valid mobile number is required for this channel');
    }
  }

  await updateRespondentJourney(pool, respondentId, { consentAccepted: true });
  const updated = await setRespondentContact(pool, respondentId, {
    channel: input.channel,
    email: input.channel === 'text' || input.channel === 'none' ? null : (input.email ?? null),
    phone: input.channel === 'email' || input.channel === 'none' ? null : (input.phone ?? null),
    recoveryToken: randomUUID(),
    reportDelivery: input.channel,
  });

  // Save and resume: email the respondent their own link back in (when the
  // caller supplied the site's address and an email was given).
  if (opts.portalUrl && updated.contactEmail && updated.recoveryToken) {
    const earlier = await listEmailsFor(pool, SURVEY_RESUME_EMAIL_KIND, [respondentId]);
    if (earlier.length < MAX_RESUME_EMAILS) {
      await queueNotice(pool, {
        kind: SURVEY_RESUME_EMAIL_KIND,
        audience: 'investor',
        label: 'Your survey',
        refId: respondentId,
        to: updated.contactEmail.trim(),
        subject: `Your link back to the ${STUDY_NAME} survey`,
        heading: 'Your link back to the survey',
        paragraphs: [
          `Thank you for taking part in the ${STUDY_NAME} survey.`,
          'Your answers save as you go. If you stop part-way, use the link below to come back to where you left off — on this device or another.',
          'The link is personal to you: anyone who has it can see and change your answers, so please do not forward it. Any earlier link we sent you no longer works.',
        ],
        action: {
          label: 'Return to my survey',
          url: surveyResumeLink(opts.portalUrl, updated.recoveryToken),
        },
        footer: 'You are receiving this because you gave this address in the survey.',
      });
    }
  }
  return updated;
}

/**
 * Set which firms a multi-firm respondent will rate. Each must be an active
 * participant in the edition. The recruiting firm is NEVER auto-added — a firm
 * is rated only because it was independently selected.
 */
export async function setRatedFirms(
  pool: Pool,
  respondentId: string,
  firmIds: string[],
): Promise<Respondent> {
  const respondent = await getRespondentById(pool, respondentId);
  if (!respondent) throw new DomainError('Respondent not found', 'RESPONDENT_NOT_FOUND');
  await assertCollectionOpen(pool, respondent.editionId);

  const active = new Set(
    (await getActiveEditionParticipants(pool, respondent.editionId)).map((o) => o.id),
  );
  for (const id of firmIds) {
    if (!active.has(id)) {
      throw new ResponseScopeError(`Firm ${id} is not an active participant in this edition`);
    }
  }
  return updateRespondentJourney(pool, respondentId, { ratedFirmIds: firmIds });
}

/** Autosave one answer as a mutable draft (no save control). Validates scope. */
export async function saveDraftAnswer(
  pool: Pool,
  respondentId: string,
  data: { questionId: string; ratedFirmId: string | null; answer: AnswerValue; step?: number },
): Promise<RespondentDraft> {
  const respondent = await getRespondentById(pool, respondentId);
  if (!respondent) throw new DomainError('Respondent not found', 'RESPONDENT_NOT_FOUND');
  if (respondent.withdrawnAt) throw new ParticipationClosedError();
  // Sent answers are final: a late autosave (a second tab, a retry) never
  // changes a draft behind a submitted response.
  if (respondent.submittedAt) throw new AlreadySubmittedError();
  await assertLinkValid(pool, respondentId);
  await assertCollectionOpen(pool, respondent.editionId);

  const items = await getInstrumentItems(pool, respondent.instrumentCode);
  const item = items.find((i) => i.id === data.questionId);
  // The respondent reads these messages: the question's ID stays out of them
  // (D-18) and travels on the error instead.
  const scope = { questionId: data.questionId };
  if (!item) throw new ResponseScopeError('This question is not part of this survey.', scope);

  if (item.scope === 'firm_specific') {
    if (!data.ratedFirmId || !respondent.ratedFirmIds.includes(data.ratedFirmId)) {
      throw new ResponseScopeError(
        'This question is about a firm you chose to rate: choose the firm first.',
        scope,
      );
    }
  } else if (data.ratedFirmId !== null) {
    throw new ResponseScopeError(
      'This question is about your experience overall, not about one firm.',
      scope,
    );
  }

  // A scope gate already answered with a closing option ends the instrument:
  // nothing after it may be answered (the same shared route the renderer and
  // the submit check use). Changing the gate's own answer stays open.
  const sequence = buildJourneySequence(items, respondent.ratedFirmIds);
  const drafts = await listDraftsForRespondent(pool, respondentId);
  const saved = new Map(drafts.map((d) => [`${d.questionId}::${d.ratedFirmId ?? ''}`, d.answer]));
  const gated = applyScopeGate(sequence, (s) => saved.get(`${s.item.id}::${s.ratedFirmId ?? ''}`));
  if (
    gated.closedAt !== null &&
    !gated.steps.some((s) => s.item.id === data.questionId && s.ratedFirmId === data.ratedFirmId)
  ) {
    throw new ScopeClosedError(data.questionId);
  }

  const draft = await upsertDraft(pool, {
    respondentId,
    questionId: data.questionId,
    scope: item.scope,
    ratedFirmId: data.ratedFirmId,
    answer: data.answer,
  });
  if (data.step !== undefined) {
    await updateRespondentJourney(pool, respondentId, { resumeStep: data.step });
  }
  return draft;
}

/** What saving one answer did (`saveAnswer`). */
export interface SavedAnswer {
  draft: RespondentDraft;
  /** The answer closed the survey at a scope gate (Q0 "Rare" / "Effectively none"). */
  closedByScopeGate: boolean;
  /** The response was sent with this answer: a closing gate answer finishes it. */
  submitted: boolean;
}

/**
 * The respondent's autosave (D-21). Saves the draft and, when the answer is a
 * scope gate's closing option, finishes the response there and then: the
 * survey ends on the answer itself, not on a later button. A response closed
 * this way is submitted like any other — confirmed, thanked (I-04), never
 * reminded — so no reload or lost request can leave it open and stuck behind
 * a gate the server already enforces.
 *
 * Should the submit not go through (an unanswered item before the gate, a
 * consent the instrument needs), the draft still stands and `submitted` is
 * false, so the renderer offers the ordinary send.
 */
export async function saveAnswer(
  pool: Pool,
  respondentId: string,
  data: { questionId: string; ratedFirmId: string | null; answer: AnswerValue; step?: number },
  opts: { portalUrl?: string } = {},
): Promise<SavedAnswer> {
  const draft = await saveDraftAnswer(pool, respondentId, data);
  const respondent = await getRespondentById(pool, respondentId);
  const items = respondent ? await getInstrumentItems(pool, respondent.instrumentCode) : [];
  const item = items.find((i) => i.id === data.questionId);
  if (!item || !closesScope(item, data.answer)) {
    return { draft, closedByScopeGate: false, submitted: false };
  }
  try {
    await submitJourney(pool, respondentId, opts);
    return { draft, closedByScopeGate: true, submitted: true };
  } catch (err) {
    // A concurrent submit (a second tab, the renderer's own retry) got there first.
    if (err instanceof AlreadySubmittedError) {
      return { draft, closedByScopeGate: true, submitted: true };
    }
    if (err instanceof ReviewGapError || err instanceof ConsentRequiredError) {
      return { draft, closedByScopeGate: true, submitted: false };
    }
    throw err;
  }
}

export interface ResumeState {
  respondent: Respondent;
  /** The instrument, resolved from the Survey Register (UX-INS-003
   *  register_resolved_instrument): its name and type drive the start screen. */
  instrument: { code: string; name: string; instrumentType: string } | null;
  items: SurveyItem[];
  drafts: RespondentDraft[];
  firmContext: { ratedFirmId: string | null; firmIndex: number; firmCount: number };
  /** A scope gate's closing answer ends this survey (D-21): the renderer goes
   *  to the thank-you rather than to any question after it. */
  closedByScopeGate: boolean;
}

/** Restore a journey to its exact last-valid point, INCLUDING which rated firm
 *  was being answered in a multi-firm loop — not just the question number. */
export async function getResume(pool: Pool, respondentId: string): Promise<ResumeState> {
  const respondent = await getRespondentById(pool, respondentId);
  if (!respondent) throw new DomainError('Respondent not found', 'RESPONDENT_NOT_FOUND');
  const items = await getInstrumentItems(pool, respondent.instrumentCode);
  const saved = await listDraftsForRespondent(pool, respondentId);
  const sequence = buildJourneySequence(items, respondent.ratedFirmIds);
  const firmContext = firmContextAt(sequence, respondent.resumeStep);
  const byKey = new Map(saved.map((d) => [`${d.questionId}::${d.ratedFirmId ?? ''}`, d.answer]));
  const closedByScopeGate =
    applyScopeGate(sequence, (s) => byKey.get(`${s.item.id}::${s.ratedFirmId ?? ''}`)).closedAt !==
    null;
  // Once sent, the answers are final and nothing needs them back: a submitted
  // response's resume state carries none, so holding its id (or its link)
  // never reads what was answered.
  const drafts = respondent.submittedAt ? [] : saved;
  const def = (await listInstrumentDefinitions(pool)).find(
    (d) => d.code === respondent.instrumentCode,
  );
  const instrument = def
    ? { code: def.code, name: def.name, instrumentType: def.instrumentType }
    : null;
  return { respondent, instrument, items, drafts, firmContext, closedByScopeGate };
}

/** Resume by recovery token (emailed link, or device-bound token for no-contact
 *  respondents). The token is the key back into the response record. */
export async function getResumeByToken(pool: Pool, token: string): Promise<ResumeState | null> {
  const respondent = await getRespondentByRecoveryToken(pool, token);
  if (!respondent) return null;
  return getResume(pool, respondent.id);
}

/**
 * Freeze all draft answers into the immutable `responses` record and mark the
 * respondent submitted. Enforces the consent gate and, as the server-side
 * review-before-submit check, requires every required item in the journey to be
 * answered — otherwise a ReviewGapError names what is outstanding. The
 * submission confirmation (and a firm seat's coordinator notice) is queued in
 * the same transaction; `portalUrl` is the public site for its links.
 */
export async function submitJourney(
  pool: Pool,
  respondentId: string,
  opts: { portalUrl?: string } = {},
): Promise<Response[]> {
  const respondent = await getRespondentById(pool, respondentId);
  if (!respondent) throw new DomainError('Respondent not found', 'RESPONDENT_NOT_FOUND');
  if (respondent.withdrawnAt) throw new ParticipationClosedError();
  if (respondent.submittedAt) throw new AlreadySubmittedError();
  await assertLinkValid(pool, respondentId);
  await assertCollectionOpen(pool, respondent.editionId);

  if (requiresConsent(respondent.instrumentCode) && !respondent.consentAccepted) {
    throw new ConsentRequiredError(respondent.instrumentCode);
  }

  const items = await getInstrumentItems(pool, respondent.instrumentCode);
  const drafts = await listDraftsForRespondent(pool, respondentId);
  const draftKey = (qid: string, firmId: string | null): string => `${qid}::${firmId ?? ''}`;
  const draftMap = new Map(drafts.map((d) => [draftKey(d.questionId, d.ratedFirmId), d]));
  // The journey as the respondent saw it: a scope gate answered with a closing
  // option (Q0 "Rare" / "Effectively none") ends it there. Nothing after the
  // gate is required, and nothing after it is recorded — a later draft left
  // over from before the gate was changed is ignored, never submitted.
  const gated = applyScopeGate(
    buildJourneySequence(items, respondent.ratedFirmIds),
    (s) => draftMap.get(draftKey(s.item.id, s.ratedFirmId))?.answer,
  );
  const sequence = gated.steps;
  const closedByScopeGate = gated.closedAt !== null;

  const outstanding: Array<{ questionId: string; ratedFirmId: string | null }> = [];
  for (const step of sequence) {
    const d = draftMap.get(draftKey(step.item.id, step.ratedFirmId));
    if (!isAnswered(step.item, d?.answer)) {
      outstanding.push({ questionId: step.item.id, ratedFirmId: step.ratedFirmId });
    }
  }
  if (outstanding.length > 0) throw new ReviewGapError(outstanding);

  return withTransaction(pool, async (client) => {
    // Two submits at once: the second waits on this row lock, then sees the
    // first one's submission and stops — no duplicate answers, no second email.
    const locked = await client.query<{ submitted_at: Date | null }>(
      'SELECT submitted_at FROM respondents WHERE id = $1 FOR UPDATE',
      [respondentId],
    );
    if (locked.rows[0]?.submitted_at) throw new AlreadySubmittedError();
    // Re-checked under a share lock: a results lock approved while this
    // submission is in flight either waits for it or is seen here.
    await assertCollectionOpen(client as unknown as Pool, respondent.editionId, {
      forShare: true,
    });
    const rows = [];
    for (const step of sequence) {
      const d = draftMap.get(draftKey(step.item.id, step.ratedFirmId));
      if (!d) continue;
      rows.push({
        editionId: respondent.editionId,
        respondentId,
        questionId: step.item.id,
        scope: step.item.scope,
        ratedFirmId: step.ratedFirmId,
        answer: d.answer,
      });
    }
    // One statement for every answer, not a round-trip per answer.
    const written: Response[] = await insertResponses(client as unknown as Pool, rows);
    await markRespondentSubmitted(client as unknown as Pool, respondentId);
    // One completed funnel event per response, in the same transaction so the
    // event stream can never drift from the finalized response.
    await emitCompletedForRespondent(client as unknown as Pool, respondent, { source: 'direct' });
    // A regulator answering through the link issued from the Regulators screen
    // confirms that role — nobody has to remember to record it by hand.
    await confirmEngagementForSubmittedRespondent(client as unknown as Pool, respondentId, {
      closedByScopeGate,
    });
    // D-02: confirm the submission by email (when an address is known) in the
    // same transaction — a submission that rolls back sends nothing, and a
    // repeated submit queues no second notice.
    await queueSubmissionConfirmation(client, respondent, {
      closedByScopeGate,
      portalUrl: opts.portalUrl,
    });
    return written;
  });
}

/**
 * A post-completion retail referral. A referred respondent starts a completely
 * independent journey and NEVER inherits the referrer's recruiting/source firm
 * attribution (PAT-010).
 */
export async function createReferral(
  pool: Pool,
  data: { editionId: string; instrumentCode: string; referredByRespondentId: string },
): Promise<Respondent> {
  return startJourney(pool, {
    editionId: data.editionId,
    instrumentCode: data.instrumentCode,
    recruitingFirmId: null, // never the referrer's firm
    referredByRespondentId: data.referredByRespondentId,
  });
}

/**
 * An institutional colleague invite. The colleague answers independently — not
 * linked to the inviter or to other colleagues — carrying only the institution
 * name for grouping. No inviter link is stored, by design.
 */
export async function createColleagueInvite(
  pool: Pool,
  data: { editionId: string; instrumentCode: string; institutionName: string },
): Promise<Respondent> {
  return startJourney(pool, {
    editionId: data.editionId,
    instrumentCode: data.instrumentCode,
    recruitingFirmId: null,
    institutionName: data.institutionName,
  });
}
