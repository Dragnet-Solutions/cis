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
} from '@cis/db';
import {
  buildJourneySequence,
  firmContextAt,
  isAnswered,
  requiresConsent,
  type AnswerValue,
  type SurveyItem,
} from '@cis/survey';
import type { Respondent, RespondentDraft, Response } from '@cis/shared-types';
import { DomainError } from './errors';
import { ConsentRequiredError, ResponseScopeError } from './response-service';
import { emitCompletedForRespondent } from './funnel-service';
import { ParticipationClosedError } from './shared-error-service';
import { isRegulatorInstrument } from './institution-family-service';

/** A required contact-collecting surface was progressed without accepted consent. */
export { ConsentRequiredError };

export class ReviewGapError extends DomainError {
  constructor(
    public readonly outstanding: Array<{ questionId: string; ratedFirmId: string | null }>,
  ) {
    super('The survey has unanswered required items and cannot be submitted', 'REVIEW_GAP');
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
  if (isRegulatorInstrument(data.instrumentCode)) throw new RegulatorLinkRequiredError();
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
  return setRespondentContact(pool, respondentId, {
    channel: input.channel,
    email: input.channel === 'text' || input.channel === 'none' ? null : (input.email ?? null),
    phone: input.channel === 'email' || input.channel === 'none' ? null : (input.phone ?? null),
    recoveryToken: randomUUID(),
    reportDelivery: input.channel,
  });
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
  await assertCollectionOpen(pool, respondent.editionId);

  const items = await getInstrumentItems(pool, respondent.instrumentCode);
  const item = items.find((i) => i.id === data.questionId);
  if (!item) throw new ResponseScopeError(`${data.questionId} is not part of this instrument`);

  if (item.scope === 'firm_specific') {
    if (!data.ratedFirmId || !respondent.ratedFirmIds.includes(data.ratedFirmId)) {
      throw new ResponseScopeError(`${data.questionId} needs a selected rated firm`);
    }
  } else if (data.ratedFirmId !== null) {
    throw new ResponseScopeError(`${data.questionId} is a shared item and takes no rated firm`);
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

export interface ResumeState {
  respondent: Respondent;
  items: SurveyItem[];
  drafts: RespondentDraft[];
  firmContext: { ratedFirmId: string | null; firmIndex: number; firmCount: number };
}

/** Restore a journey to its exact last-valid point, INCLUDING which rated firm
 *  was being answered in a multi-firm loop — not just the question number. */
export async function getResume(pool: Pool, respondentId: string): Promise<ResumeState> {
  const respondent = await getRespondentById(pool, respondentId);
  if (!respondent) throw new DomainError('Respondent not found', 'RESPONDENT_NOT_FOUND');
  const items = await getInstrumentItems(pool, respondent.instrumentCode);
  const drafts = await listDraftsForRespondent(pool, respondentId);
  const sequence = buildJourneySequence(items, respondent.ratedFirmIds);
  const firmContext = firmContextAt(sequence, respondent.resumeStep);
  return { respondent, items, drafts, firmContext };
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
 * answered — otherwise a ReviewGapError names what is outstanding.
 */
export async function submitJourney(pool: Pool, respondentId: string): Promise<Response[]> {
  const respondent = await getRespondentById(pool, respondentId);
  if (!respondent) throw new DomainError('Respondent not found', 'RESPONDENT_NOT_FOUND');
  if (respondent.withdrawnAt) throw new ParticipationClosedError();
  await assertCollectionOpen(pool, respondent.editionId);

  if (requiresConsent(respondent.instrumentCode) && !respondent.consentAccepted) {
    throw new ConsentRequiredError(respondent.instrumentCode);
  }

  const items = await getInstrumentItems(pool, respondent.instrumentCode);
  const sequence = buildJourneySequence(items, respondent.ratedFirmIds);
  const drafts = await listDraftsForRespondent(pool, respondentId);
  const draftKey = (qid: string, firmId: string | null): string => `${qid}::${firmId ?? ''}`;
  const draftMap = new Map(drafts.map((d) => [draftKey(d.questionId, d.ratedFirmId), d]));

  const outstanding: Array<{ questionId: string; ratedFirmId: string | null }> = [];
  for (const step of sequence) {
    const d = draftMap.get(draftKey(step.item.id, step.ratedFirmId));
    if (!isAnswered(step.item, d?.answer)) {
      outstanding.push({ questionId: step.item.id, ratedFirmId: step.ratedFirmId });
    }
  }
  if (outstanding.length > 0) throw new ReviewGapError(outstanding);

  return withTransaction(pool, async (client) => {
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
    await confirmEngagementForSubmittedRespondent(client as unknown as Pool, respondentId);
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
