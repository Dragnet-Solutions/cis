import { randomInt } from 'node:crypto';
import {
  applyScopeGate,
  buildJourneySequence,
  isAnswered,
  type AnswerValue,
  type SurveyItem,
} from '@cis/survey';
import { Api, ApiError, sleep } from './api';
import { generateAnswer, type Persona } from './answers';
import { fakePerson } from './names';
import {
  SEAT_CODES,
  SEGMENT_OUTREACH,
  relationshipGoodness,
  type Plan,
  type PlannedFirm,
  type PlannedInvestor,
  type PlannedSeat,
} from './plan';
import { Rng, clamp } from './rng';
import type { FirmState, RespondentState, RobotState } from './state';

/**
 * Each flow plays one real person through the same HTTP calls the browser
 * pages make (apps/admin/src/journey/*, the firm portal), in the same order:
 *
 *  - coordinator: POST /firm/claim (with the firm's invitation token) →
 *    POST /portal/auth/login → GET /portal/me
 *    → GET /portal/seats → POST /portal/seats/:code/assign (empty seats only)
 *    → GET /portal/can-invite → GET /portal/outreach
 *  - seat holder: GET /firm-seats/:t/context → POST start → answers → submit
 *    → POST /firm-seats/:t/complete
 *  - investor: [GET /outreach/:t/context, event opens] → POST /journeys →
 *    POST contact (consent) → POST rated-firms → [event starts] → answers →
 *    submit → [event finishes]
 *  - regulator: GET /journeys/resume/:token → answers → submit
 *
 * Every step is resumable: what was created is written to the state file
 * straight away, and a re-run picks up from the server's own resume state.
 */

/** Stop the whole run (not just this respondent). */
export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}
/** The run is stopping; the respondent is left resumable. */
export class StopRequested extends Error {
  constructor() {
    super('stopping');
    this.name = 'StopRequested';
  }
}

export interface FlowContext {
  api: Api;
  plan: Plan;
  state: RobotState;
  editionId: string;
  save: () => void;
  /** Pause a respondent "thinks" before answering the next question. */
  thinkMs: (persona: Persona, rng: Rng) => number;
  isStopping: () => boolean;
  log: (line: string) => void;
  /** The firm's invitation token (from --firm-invites), if one was given. */
  inviteTokenFor: (firm: PlannedFirm) => string | null;
  /** Share of regulators who close a scope gate (Q0); 0 = never. */
  scopeGateCloseShare?: number;
}

/** Why a firm with no usable invitation link was not claimed. */
export const NO_INVITE_REASON =
  'no invitation link for this firm — pass --firm-invites <file> (the CSV from the Firm team ' +
  'screen\'s "Download open links"), or run the API with FIRM_CLAIM_WITHOUT_INVITE=true ' +
  '(test runs only; [Test] firms only)';

interface ResumeState {
  respondent: {
    id: string;
    instrumentCode: string;
    ratedFirmIds: string[];
    consentAccepted: boolean;
    submittedAt: string | null;
  };
  items: SurveyItem[];
  drafts: Array<{ questionId: string; ratedFirmId: string | null; answer: AnswerValue }>;
}

const FATAL_ERRORS = new Set(['CollectionClosedError']);

function fatalIfClosed(e: unknown): never {
  if (e instanceof ApiError && FATAL_ERRORS.has(e.errorName)) {
    throw new FatalError(`The edition is not accepting responses: ${e.message}`);
  }
  throw e;
}

function firmState(ctx: FlowContext, firm: PlannedFirm): FirmState {
  return (ctx.state.firmState[firm.id] ??= {
    name: firm.name,
    coordinator: null,
    claim: null,
    seats: {},
    outreach: {},
  });
}

function firmTag(ctx: FlowContext, firmId: string): string {
  const i = ctx.plan.firms.findIndex((f) => f.id === firmId);
  return `f${String(i + 1).padStart(3, '0')}`;
}

export function firmSetupComplete(fs: FirmState | undefined): boolean {
  if (!fs) return false;
  if (fs.claim === 'other') return true;
  return (
    fs.claim === 'claimed' &&
    SEAT_CODES.every((c) => !!fs.seats[c]?.linkToken) &&
    Object.values(SEGMENT_OUTREACH).every((s) => !!fs.outreach[s])
  );
}

const SEAT_ROLES: Record<'S1' | 'S2' | 'S3', string> = {
  S1: 'Managing Director',
  S2: 'Head of Compliance',
  S3: 'Head of Operations',
};

/**
 * The coordinator's part for one firm: claim its space (once, ever), sign in,
 * assign the three seats that are still empty, and read the outreach links.
 * A seat that is already assigned is never reassigned — that would mint a new
 * link and discard anything its holder had started.
 */
export async function setupFirm(ctx: FlowContext, firm: PlannedFirm): Promise<string> {
  const fs = firmState(ctx, firm);
  if (fs.claim === 'other') return 'claimed by someone else — skipped';
  if (firmSetupComplete(fs)) return 'already set up';
  const tag = firmTag(ctx, firm.id);

  if (!fs.coordinator) {
    const p = fakePerson(Rng.derive(ctx.plan.seed, 'coordinator', firm.id), `c.${tag}`);
    fs.coordinator = { ...p, pin: String(randomInt(0, 1_000_000)).padStart(6, '0') };
    fs.claim = 'pending';
    ctx.save(); // before the claim, so a crash mid-claim can still sign in
  }
  const coord = fs.coordinator;

  // Set when the server refused the claim for want of a usable invitation.
  let refused: string | null = null;
  if (fs.claim !== 'claimed') {
    const inviteToken = ctx.inviteTokenFor(firm);
    try {
      await ctx.api.post('/firm/claim', {
        organizationId: firm.id,
        contactName: coord.name,
        contactEmail: coord.email,
        mobile: coord.phone,
        pin: coord.pin,
        role: 'Investor Relations Lead',
        privacyConsent: true,
        followUpConsent: false,
        ...(inviteToken ? { inviteToken } : {}),
      });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.errorName === 'InvitationRequiredError' || e.errorName === 'FirmInvitationError') {
        // No link, or the link was refused (used, expired, withdrawn, another
        // firm's). A used link may be our own earlier claim (crash before
        // saving), so signing in below decides.
        refused = inviteToken ? `the invitation link was refused: ${e.message}` : NO_INVITE_REASON;
      } else if (e.errorName !== 'AlreadyClaimedError') {
        throw e;
      }
      // AlreadyClaimed: either our own earlier claim or someone else's.
    }
  }

  let token: string;
  try {
    token = (
      await ctx.api.post<{ token: string }>('/portal/auth/login', {
        email: coord.email,
        pin: coord.pin,
      })
    ).token;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && refused) {
      fs.lastError = `Not claimed: ${refused}`;
      ctx.save();
      return `skipped — ${refused}`;
    }
    if (e instanceof ApiError && e.status === 401) {
      fs.claim = 'other';
      fs.lastError = 'Firm was already claimed by someone else';
      ctx.save();
      return 'claimed by someone else — skipped';
    }
    throw e;
  }
  fs.claim = 'claimed';
  ctx.save();

  const me = await ctx.api.get<{ currentEdition: { id: string; status: string } | null }>(
    '/portal/me',
    token,
  );
  if (me.currentEdition?.id !== ctx.editionId) {
    throw new FatalError(
      `The firm portal works on edition ${me.currentEdition?.id ?? 'none'}, not ${ctx.editionId}. ` +
        'Only the open (collecting) edition can be used.',
    );
  }

  const { seats } = await ctx.api.get<{
    seats: Array<{
      seatCode: 'S1' | 'S2' | 'S3';
      state: string;
      linkToken: string;
      assignedEmail: string | null;
    }>;
  }>('/portal/seats', token);
  let assigned = 0;
  for (const code of SEAT_CODES) {
    const seat = seats.find((s) => s.seatCode === code);
    if (!seat) throw new Error(`Seat ${code} missing for ${firm.name}`);
    if (seat.state === 'empty') {
      const holder = fakePerson(
        Rng.derive(ctx.plan.seed, 'seat-holder', firm.id, code),
        `${code}.${tag}`,
      );
      const res = await ctx.api.post<{ seat: { linkToken: string } }>(
        `/portal/seats/${code}/assign`,
        { assignedName: `${holder.name} (${SEAT_ROLES[code]})`, assignedEmail: holder.email },
        token,
      );
      fs.seats[code] = { linkToken: res.seat.linkToken, assignedEmail: holder.email };
      assigned++;
    } else {
      fs.seats[code] = { linkToken: seat.linkToken, assignedEmail: seat.assignedEmail };
    }
    ctx.save();
  }

  await ctx.api.get('/portal/can-invite', token);
  const { links } = await ctx.api.get<{
    links: Array<{ token: string; segment: keyof FirmState['outreach'] }>;
  }>('/portal/outreach', token);
  for (const l of links) fs.outreach[l.segment] = l.token;
  delete fs.lastError;
  ctx.save();
  return `claimed, ${assigned} seat(s) assigned, ${links.length} outreach links`;
}

// ── Answering ────────────────────────────────────────────────────────────────

/**
 * Answer every step of the journey the server describes (shared items once,
 * firm-specific items once per rated firm), skipping anything already saved,
 * then submit. Returns the number of answers saved in this call.
 */
async function answerAndSubmit(
  ctx: FlowContext,
  resume: ResumeState,
  persona: Persona,
  rng: Rng,
  goodnessFor: (item: SurveyItem, ratedFirmId: string | null) => number | null,
  closeScopeGate = false,
): Promise<number> {
  const respondentId = resume.respondent.id;
  const key = (q: string, f: string | null): string => `${q}::${f ?? ''}`;
  const answers = new Map(resume.drafts.map((d) => [key(d.questionId, d.ratedFirmId), d.answer]));
  const fullSequence = buildJourneySequence(resume.items, resume.respondent.ratedFirmIds);
  if (fullSequence.length === 0)
    throw new Error(`No questions for ${resume.respondent.instrumentCode}`);
  // The same scope-gate route the renderer and server use: a closing answer
  // to a gate (Q0) ends the journey there, so it is recomputed per answer.
  const route = () =>
    applyScopeGate(fullSequence, (s) => answers.get(key(s.item.id, s.ratedFirmId))).steps;

  let saved = 0;
  for (let step = 0; step < route().length; step++) {
    const { item, ratedFirmId } = route()[step]!;
    const k = key(item.id, ratedFirmId);
    if (isAnswered(item, answers.get(k)) && answers.has(k)) continue;
    if (ctx.isStopping()) throw new StopRequested();
    await sleep(ctx.thinkMs(persona, rng));
    const answer = generateAnswer(item, {
      rng,
      persona,
      goodness: goodnessFor(item, ratedFirmId),
      closeScopeGate,
    });
    if (answer === null) continue; // an optional item left blank — nothing is saved
    if (!isAnswered(item, answer)) {
      throw new Error(`Generated an incomplete answer for ${item.id}: ${JSON.stringify(answer)}`);
    }
    await ctx.api
      .put(`/journeys/${respondentId}/answers`, {
        questionId: item.id,
        ratedFirmId,
        answer,
        step,
      })
      .catch(fatalIfClosed);
    answers.set(k, answer);
    saved++;
  }

  const gaps = route().filter(
    (s) => !isAnswered(s.item, answers.get(key(s.item.id, s.ratedFirmId))),
  );
  if (gaps.length > 0) {
    throw new Error(`Review gap before submit: ${gaps.map((g) => g.item.id).join(', ')}`);
  }
  await sleep(ctx.thinkMs(persona, rng)); // the review-before-submit screen
  try {
    await ctx.api.post(`/journeys/${respondentId}/submit`);
  } catch (e) {
    // A submit whose response was lost may still have landed: check before
    // treating it as a failure (a second submit would be refused anyway).
    const again = await ctx.api.get<ResumeState>(`/journeys/${respondentId}/resume`);
    if (!again.respondent.submittedAt) fatalIfClosed(e);
  }
  return saved;
}

async function getResume(ctx: FlowContext, respondentId: string): Promise<ResumeState> {
  return ctx.api.get<ResumeState>(`/journeys/${respondentId}/resume`);
}

function record(ctx: FlowContext, key: string, patch: Partial<RespondentState>): RespondentState {
  const prev = ctx.state.respondents[key];
  const next: RespondentState = {
    status: 'started',
    instrument: '',
    attempts: 0,
    ...prev,
    ...patch,
  };
  ctx.state.respondents[key] = next;
  ctx.save();
  return next;
}

function markSubmitted(ctx: FlowContext, key: string): void {
  const r = record(ctx, key, { status: 'submitted', submittedAt: new Date().toISOString() });
  delete r.lastError;
  ctx.save();
}

const NORMAL: Persona = { kind: 'normal' };

// ── Firm seats ───────────────────────────────────────────────────────────────

export async function runSeat(ctx: FlowContext, seat: PlannedSeat): Promise<string> {
  const firm = ctx.plan.firms.find((f) => f.id === seat.firmId)!;
  const fs = ctx.state.firmState[firm.id];
  const link = fs?.seats[seat.seatCode]?.linkToken;
  if (fs?.claim === 'other') throw new Error(`${firm.name} was claimed by someone else`);
  if (!link) throw new Error(`${firm.name} has no ${seat.seatCode} link yet (firm not set up)`);
  const prev = ctx.state.respondents[seat.key];
  record(ctx, seat.key, { instrument: seat.seatCode, attempts: (prev?.attempts ?? 0) + 1 });

  const context = await ctx.api.get<{ state: string; editionStatus: string }>(
    `/firm-seats/${link}/context`,
  );
  if (context.state === 'complete') {
    markSubmitted(ctx, seat.key);
    return 'already complete';
  }
  if (context.editionStatus !== 'open') {
    throw new FatalError(`Edition is ${context.editionStatus}, not collecting`);
  }
  const { respondentId } = await ctx.api
    .post<{ respondentId: string }>(`/firm-seats/${link}/start`)
    .catch(fatalIfClosed);
  record(ctx, seat.key, { respondentId, startedAt: prev?.startedAt ?? new Date().toISOString() });

  const resume = await getResume(ctx, respondentId);
  let saved = 0;
  if (!resume.respondent.submittedAt) {
    const rng = Rng.derive(ctx.plan.seed, 'answers', seat.key);
    // A seat holder answers about their own firm: its quality, plus their own view.
    const own = clamp(firm.quality + rng.normal(0, 0.08), 0, 1);
    saved = await answerAndSubmit(ctx, resume, NORMAL, rng, () =>
      clamp(own + rng.normal(0, 0.06), 0, 1),
    );
  }
  await ctx.api.post(`/firm-seats/${link}/complete`);
  markSubmitted(ctx, seat.key);
  return `${saved} answers`;
}

// ── Investors (retail S4, local S5a, foreign S5b) ────────────────────────────

let consentChecked = false;
let activeFirms: Set<string> | null = null;

export async function runInvestor(ctx: FlowContext, inv: PlannedInvestor): Promise<string> {
  const prev = ctx.state.respondents[inv.key];
  let respondentId = prev?.respondentId;
  let via = prev ? (prev.viaFirmId ?? null) : inv.viaFirmId;
  const segment = SEGMENT_OUTREACH[inv.segment];
  let outreachToken = via ? ctx.state.firmState[via]?.outreach[segment] : undefined;

  if (!respondentId) {
    if (via && !outreachToken) {
      // The firm never got set up (claimed by someone else, or failed):
      // this person finds the survey through the public entry instead.
      via = null;
    }
    if (via && outreachToken) {
      const oc = await ctx.api.get<{ organizationId: string }>(
        `/outreach/${outreachToken}/context`,
      );
      if (oc.organizationId !== via) throw new Error(`Outreach link does not belong to ${via}`);
      await ctx.api.post(`/outreach/${outreachToken}/event`, { event: 'opens' });
    }
    if (!consentChecked) {
      const c = await ctx.api.get<{ consent: unknown }>('/journeys/consent-content');
      if (!c.consent) ctx.log('warning: no consent wording is configured on the server');
      consentChecked = true;
    }
    if (!activeFirms) {
      const { firms } = await ctx.api.get<{ firms: Array<{ id: string }> }>(
        `/journeys/editions/${ctx.editionId}/participating-firms`,
      );
      activeFirms = new Set(firms.map((f) => f.id));
    }
    const missing = inv.ratedFirmIds.filter((id) => !activeFirms!.has(id));
    if (missing.length > 0)
      throw new Error(`Rated firm(s) not participating: ${missing.join(', ')}`);
    await sleep(ctx.thinkMs(inv.persona, Rng.derive(ctx.plan.seed, 'entry', inv.key)) * 2);

    const started = await ctx.api
      .post<{ respondentId: string }>('/journeys', {
        editionId: ctx.editionId,
        instrumentCode: inv.instrument,
        recruitingFirmId: via,
        institutionName: inv.institutionName,
      })
      .catch(fatalIfClosed);
    respondentId = started.respondentId;
    record(ctx, inv.key, {
      instrument: inv.instrument,
      respondentId,
      viaFirmId: via,
      ratedFirmIds: inv.ratedFirmIds,
      startedAt: new Date().toISOString(),
      attempts: (prev?.attempts ?? 0) + 1,
    });
  } else {
    record(ctx, inv.key, { attempts: (prev?.attempts ?? 0) + 1 });
  }
  if (!via) outreachToken = undefined;

  let resume = await getResume(ctx, respondentId);
  if (resume.respondent.submittedAt) {
    markSubmitted(ctx, inv.key);
    return 'already submitted';
  }
  let setupChanged = false;
  if (!resume.respondent.consentAccepted) {
    await ctx.api
      .post(`/journeys/${respondentId}/contact`, {
        consentAccepted: true,
        channel: inv.contact.channel,
        email: inv.contact.email,
        phone: inv.contact.phone,
      })
      .catch(fatalIfClosed);
    setupChanged = true;
  }
  if (resume.respondent.ratedFirmIds.length === 0) {
    await ctx.api
      .post(`/journeys/${respondentId}/rated-firms`, { firmIds: inv.ratedFirmIds })
      .catch(fatalIfClosed);
    if (outreachToken) {
      await ctx.api.post(`/outreach/${outreachToken}/event`, { event: 'starts' });
    }
    setupChanged = true;
  }
  if (setupChanged) resume = await getResume(ctx, respondentId);

  const rng = Rng.derive(ctx.plan.seed, 'answers', inv.key);
  const saved = await answerAndSubmit(ctx, resume, inv.persona, rng, (item, firmId) => {
    if (inv.persona.kind !== 'normal') return null;
    if (firmId) return relationshipGoodness(ctx.plan, inv.key, firmId, inv.disposition);
    void item;
    return inv.disposition;
  });
  if (outreachToken) {
    await ctx.api.post(`/outreach/${outreachToken}/event`, { event: 'finishes' });
  }
  markSubmitted(ctx, inv.key);
  const how = via ? `via ${ctx.state.firmState[via]?.name ?? via}` : 'public entry';
  return `${inv.ratedFirmIds.length} firm(s), ${how}, ${saved} answers${
    inv.persona.kind === 'normal' ? '' : `, ${inv.persona.kind}`
  }`;
}

// ── Regulators (through the links issued on the Regulators screen) ──────────

export async function runRegulator(ctx: FlowContext, key: string, token: string): Promise<string> {
  const prev = ctx.state.respondents[key];
  const res = await ctx.api.get<
    | ({ kind: 'resume' } & ResumeState)
    | { kind: 'already_submitted' }
    | { kind: 'participation_closed' }
    | { kind: 'link_invalidated' }
  >(`/journeys/resume/${encodeURIComponent(token)}`);
  if (res.kind === 'link_invalidated') {
    // Replaced on the Market institutions screen (cancel and start again):
    // the new contact's link is a different one; this one is done with.
    throw new Error('This regulator link was replaced and no longer works; pass the new link');
  }
  if (res.kind === 'already_submitted') {
    record(ctx, key, { instrument: prev?.instrument ?? 'I-?' });
    markSubmitted(ctx, key);
    return 'already submitted';
  }
  if (res.kind === 'participation_closed') {
    throw new FatalError('A regulator link reports participation closed (edition locked?)');
  }
  record(ctx, key, {
    instrument: res.respondent.instrumentCode,
    respondentId: res.respondent.id,
    startedAt: prev?.startedAt ?? new Date().toISOString(),
    attempts: (prev?.attempts ?? 0) + 1,
  });
  const rng = Rng.derive(ctx.plan.seed, 'answers', key);
  // A market-level view: middling, with a little spread between institutions.
  const view = clamp(0.5 + rng.normal(0, 0.12), 0, 1);
  // Only when asked (--scope-gate-close): some institutions answer the scope
  // question (Q0) with a closing option, so their survey ends there.
  const closeGate = rng.chance(ctx.scopeGateCloseShare ?? 0);
  const saved = await answerAndSubmit(ctx, res, NORMAL, rng, () => view, closeGate);
  markSubmitted(ctx, key);
  return `${res.respondent.instrumentCode}, ${saved} answers${closeGate ? ' (scope gate closed)' : ''}`;
}

/** Test hook: forget the per-run caches. */
export function resetFlowCaches(): void {
  consentChecked = false;
  activeFirms = null;
}
