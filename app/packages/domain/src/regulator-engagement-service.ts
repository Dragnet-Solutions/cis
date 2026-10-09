import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  getRegulatorEngagement,
  listRegulatorEngagement,
  saveRegulatorContact,
  setRegulatorSurveyIssued,
  setRegulatorStatus,
  clearRegulatorSurvey,
  addRegulatorHistory,
  listRegulatorHistory,
  createRespondent,
  setRespondentContact,
  revokeRespondentToken,
  listInstitutionsWithRoles,
  type RegulatorEngagementRow,
} from '@cis/db';
import type {
  InstrumentFamilyCode,
  RegulatorContact,
  RegulatorEngagementView,
  RegulatorSurveyState,
} from '@cis/shared-types';
import { requirePermission, type RbacContext } from '@cis/auth';
import { DomainError } from './errors';
import { FAMILY_META, instrumentCodeForFamily } from './institution-family-service';
import { assertCollectionOpen } from './journey-service';

/**
 * UX-OPS-007 — Regulator Engagement. One page per (institution, family) role,
 * two sections in fixed order (contact, then survey) plus an append-only
 * free-text history.
 *
 * Phase 19 re-keys every function here from a fixed three-code
 * `RegulatorCode` enum to (institutionId, familyCode) — a multi-role
 * institution (CSCS: Family C and Family D) gets two independent engagement
 * rows, and a ninth institution of an existing role needs no code change.
 *
 * Deliberate shape (from the artefact, do not "improve"):
 *  - THREE states only per role: no contact → contact added → invited
 *    (plus the terminal outcomes confirmed / declined). No "ask CIS" ceremony.
 *  - A contact MUST exist before a link can be issued — enforced HERE at the
 *    service layer, not just by UI ordering.
 *  - The named contact is the one deliberate named-individual store in the estate
 *    — never tokenised. The respondent that backs the survey link stays anonymous.
 *  - Reminders are two loose channel buttons (email+text, or text-only); every
 *    other nuance of chasing is free text in the history — NOT a typed taxonomy.
 *  - Referral is cancel-and-restart: the link dies, its partial answers with it,
 *    target_by is cleared, and a fresh link goes to the new person. No chain.
 *  - Declined is terminal for the edition, EXCEPT via `reopenDeclined` (Phase 19,
 *    item 6) — a deliberate, `access:regs`-gated override with no maker-checker
 *    (this is a routine correction of a mistaken decline, not a critical action).
 *  - Each role holds its OWN lead time. Issuing a link writes the study-team
 *    date straight into Phase 10's institution_engagement.target_by (the same row
 *    condition 16 reads) — this closes Phase 10's flagged gap, no second field.
 */

export class RegulatorEngagementError extends DomainError {
  constructor(message: string, code = 'REGULATOR_ENGAGEMENT') {
    super(message, code);
  }
}

/** Descriptive taglines carried over verbatim for the three institutions this
 *  phase inherits; a ninth institution (or any of the other five seeded here)
 *  falls back to its family's generic relationship description — no code
 *  change is required to add one. */
const MANDATE_BY_INSTITUTION_NAME: Record<string, { family: InstrumentFamilyCode; text: string }> =
  {
    'Securities and Exchange Commission': {
      family: 'A',
      text: 'Supervision of licensed stockbroking firms',
    },
    'Nigerian Exchange Limited': { family: 'B', text: 'Trading, membership and listing support' },
    'Central Securities Clearing System': { family: 'C', text: 'Clearing, settlement and custody' },
  };

/** A tagline describes one role, so it applies only to that family — CSCS's
 *  depository role (Family D) must not read "Clearing, settlement and custody". */
function mandateFor(institutionName: string, familyCode: InstrumentFamilyCode): string {
  const tagline = MANDATE_BY_INSTITUTION_NAME[institutionName];
  return tagline && tagline.family === familyCode
    ? tagline.text
    : FAMILY_META[familyCode].label + ' — ' + FAMILY_META[familyCode].relationship;
}

// ─── Contact validation (exact rules from the artefact) ────────────────────────

function emailOk(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
/** Digit count after stripping every non-numeric character. */
function phoneDigits(v: string): number {
  return v.replace(/[^0-9]/g, '').length;
}

/**
 * Every field is required, and email format + phone length are enforced as hard
 * validation failures with their OWN codes (so each can be asserted
 * independently). "A number too short to send a text is worse than no number: it
 * looks like a working channel."
 */
function validateContact(c: RegulatorContact): void {
  if (!c.who.trim()) throw new RegulatorEngagementError('A name is required', 'CONTACT_INCOMPLETE');
  if (!c.role.trim())
    throw new RegulatorEngagementError('A role is required', 'CONTACT_INCOMPLETE');
  if (!emailOk(c.email.trim())) {
    throw new RegulatorEngagementError(
      'That is not a working email address',
      'CONTACT_EMAIL_INVALID',
    );
  }
  if (phoneDigits(c.phone) < 10) {
    throw new RegulatorEngagementError(
      'That number is too short to send a text to',
      'CONTACT_PHONE_INVALID',
    );
  }
  if (!c.how.trim()) {
    throw new RegulatorEngagementError(
      'A "how we got to them" note is required',
      'CONTACT_INCOMPLETE',
    );
  }
}

// ─── View assembly ─────────────────────────────────────────────────────────────

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** For a genuine instant (e.g. `asOf`, an ISO timestamp off the wire, or a
 *  UTC-constructed in-memory Date such as `parseTargetBy`'s `targetDate`) —
 *  UTC is the least-ambiguous way to reduce it to a calendar day. */
function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fmtHuman(d: Date): string {
  const s = dateStr(d).split('-');
  return `${parseInt(s[2]!, 10)} ${MONTHS[parseInt(s[1]!, 10) - 1]}`;
}
/**
 * For a value read back from a `DATE` column (`row.targetBy`) — never
 * `dateStr`. A calendar date has no timezone, and node-postgres parses a
 * plain "YYYY-MM-DD" DATE value as LOCAL midnight (`new Date(year, month,
 * day)` — see the `postgres-date` package it depends on, deliberately: "will
 * be parsed as local time"). Reading it back through `dateStr`'s UTC
 * `.toISOString()` recombines a local-time construction with a UTC read,
 * which flips the day in any timezone ahead of UTC. Local getters are the
 * correct, symmetric inverse of how the value was constructed.
 */
function dbDateStr(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function deriveState(row: RegulatorEngagementRow): RegulatorSurveyState {
  if (row.status === 'declined') return 'declined';
  if (row.status === 'confirmed') return 'confirmed';
  if (!row.contact) return 'no_contact';
  if (row.status === 'not_started') return 'contact_added';
  return 'invited';
}

function nextStepFor(state: RegulatorSurveyState): string {
  switch (state) {
    case 'confirmed':
      return 'Nothing further needed';
    case 'declined':
      return 'Section must be replanned';
    case 'no_contact':
      return 'Add a contact';
    case 'contact_added':
      return 'Issue the survey link';
    case 'invited':
      return 'Waiting on their response';
  }
}

function isOverdue(row: RegulatorEngagementRow, asOf: Date): boolean {
  if (!row.targetBy) return false;
  if (!['not_started', 'invited', 'in_progress'].includes(row.status)) return false;
  return dateStr(asOf) > dbDateStr(row.targetBy);
}

async function toView(
  pool: Pool,
  row: RegulatorEngagementRow,
  asOf: Date,
  withHistory: boolean,
): Promise<RegulatorEngagementView> {
  const state = deriveState(row);
  const history = withHistory
    ? await listRegulatorHistory(pool, row.editionId, row.institutionId, row.familyCode)
    : [];
  return {
    institutionId: row.institutionId,
    familyCode: row.familyCode,
    name: row.institutionName,
    mandate: mandateFor(row.institutionName, row.familyCode),
    status: row.status,
    state,
    contact: row.contact,
    surveyLink: row.surveyLink,
    targetBy: row.targetBy ? dbDateStr(row.targetBy) : null,
    overdue: isOverdue(row, asOf),
    nextStep: nextStepFor(state),
    history,
  };
}

async function requireRow(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
): Promise<RegulatorEngagementRow> {
  const row = await getRegulatorEngagement(pool, editionId, institutionId, familyCode);
  if (!row) {
    throw new RegulatorEngagementError(
      `No engagement row for ${institutionId}/${familyCode} in this edition`,
      'NOT_FOUND',
    );
  }
  return row;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listRegulators(
  pool: Pool,
  editionId: string,
  asOf: Date = new Date(),
): Promise<RegulatorEngagementView[]> {
  const rows = await listRegulatorEngagement(pool, editionId);
  return Promise.all(rows.map((r) => toView(pool, r, asOf, false)));
}

export async function getRegulator(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
  asOf: Date = new Date(),
): Promise<RegulatorEngagementView> {
  const row = await requireRow(pool, editionId, institutionId, familyCode);
  return toView(pool, row, asOf, true);
}

/** All institutions and the family role(s) each holds — for a picker/route
 *  that needs the full roster without an edition context. */
export async function listInstitutionRoster(pool: Pool) {
  return listInstitutionsWithRoles(pool);
}

// ─── Contact (add / change / cancel-and-restart) ───────────────────────────────

/**
 * Save the named contact. If the role was already invited (a live link),
 * this IS the referral: the earlier link dies with any partial response, the lead
 * time is cleared and the survey resets to `none`. Otherwise it is a plain add or
 * change. Declined is terminal — no contact change is offered.
 */
export async function saveContact(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
  contact: RegulatorContact,
): Promise<RegulatorEngagementView> {
  validateContact(contact);
  const row = await requireRow(pool, editionId, institutionId, familyCode);
  if (row.status === 'declined') {
    throw new RegulatorEngagementError(
      'This institution has declined for this edition; its contact cannot be changed here',
      'DECLINED_TERMINAL',
    );
  }
  const trimmed: RegulatorContact = {
    who: contact.who.trim(),
    role: contact.role.trim(),
    email: contact.email.trim(),
    phone: contact.phone.trim(),
    how: contact.how.trim(),
  };
  const prev = row.contact?.who ?? null;
  const wasInvited = row.status === 'invited' || row.status === 'in_progress';

  await saveRegulatorContact(pool, editionId, institutionId, familyCode, trimmed);

  if (wasInvited) {
    // Cancel and start again: kill the live link (and its partial answers), reset.
    if (row.respondentId) await revokeRespondentToken(pool, row.respondentId);
    await clearRegulatorSurvey(pool, editionId, institutionId, familyCode);
    await addRegulatorHistory(
      pool,
      editionId,
      institutionId,
      familyCode,
      `Started again with ${trimmed.who} in place of ${prev}. The earlier link no longer works, ` +
        `and anything the previous contact had started is lost. ${trimmed.how}.`,
    );
  } else if (prev) {
    await addRegulatorHistory(
      pool,
      editionId,
      institutionId,
      familyCode,
      `Contact changed from ${prev} to ${trimmed.who}. ${trimmed.how}.`,
    );
  } else {
    await addRegulatorHistory(
      pool,
      editionId,
      institutionId,
      familyCode,
      `${trimmed.who}, ${trimmed.role}. ${trimmed.how}.`,
    );
  }
  return getRegulator(pool, editionId, institutionId, familyCode);
}

// ─── Survey link issuance (the contact-before-survey ordering gate) ────────────

function parseTargetBy(targetBy: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetBy)) {
    throw new RegulatorEngagementError(
      'A lead-time date (YYYY-MM-DD) is required',
      'TARGET_BY_INVALID',
    );
  }
  const d = new Date(`${targetBy}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new RegulatorEngagementError('That lead-time date is not valid', 'TARGET_BY_INVALID');
  }
  return d;
}

/**
 * Issue the survey link. Preconditions enforced server-side:
 *  - a saved contact MUST exist (the order on the page is the process);
 *  - the role is not already declined (terminal);
 *  - a study-team lead-time date is supplied (never computed or defaulted).
 *
 * Mints a REAL per-role access token: a respondents row for the I-{code}
 * instrument whose recovery_token resolves via GET /journeys/resume/:token, and
 * writes the lead time into Phase 10's institution_engagement.target_by.
 */
export async function issueSurveyLink(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
  input: { targetBy: string },
): Promise<RegulatorEngagementView> {
  const row = await requireRow(pool, editionId, institutionId, familyCode);
  if (row.status === 'declined') {
    throw new RegulatorEngagementError(
      'This institution has declined for this edition; no link can be issued',
      'DECLINED_TERMINAL',
    );
  }
  if (!row.contact) {
    throw new RegulatorEngagementError(
      'A contact must be saved before a survey link can be issued',
      'CONTACT_REQUIRED_FIRST',
    );
  }
  // A link issued after the lock could only ever be refused: issue none.
  await assertCollectionOpen(pool, editionId);
  const targetDate = parseTargetBy(input.targetBy);
  const instrumentCode = instrumentCodeForFamily(familyCode);

  // Mint the real access token into the UX-INS-003 runtime (anonymous respondent).
  const respondent = await createRespondent(pool, {
    editionId,
    instrumentCode,
    institutionName: row.institutionName,
  });
  const token = randomUUID();
  await setRespondentContact(pool, respondent.id, { channel: 'none', recoveryToken: token });
  const surveyLink = `/journeys/resume/${token}`;

  await setRegulatorSurveyIssued(pool, editionId, institutionId, familyCode, {
    // The validated string, not `targetDate` — see setRegulatorSurveyIssued's
    // own comment on why a Date object must never cross this boundary.
    targetBy: input.targetBy,
    surveyLink,
    respondentId: respondent.id,
  });
  await addRegulatorHistory(
    pool,
    editionId,
    institutionId,
    familyCode,
    `Survey link issued to ${row.contact.who} by email and text. Expected back by ${fmtHuman(targetDate)}.`,
  );
  return getRegulator(pool, editionId, institutionId, familyCode);
}

// ─── Reminders (two loose channels; no count / escalation tier) ────────────────

function requireActiveLink(row: RegulatorEngagementRow): void {
  if (row.status !== 'invited' && row.status !== 'in_progress') {
    throw new RegulatorEngagementError('No active survey link to remind against', 'NO_ACTIVE_LINK');
  }
}

export async function sendReminder(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
): Promise<RegulatorEngagementView> {
  const row = await requireRow(pool, editionId, institutionId, familyCode);
  requireActiveLink(row);
  await addRegulatorHistory(
    pool,
    editionId,
    institutionId,
    familyCode,
    `Reminder sent by email and text to ${row.contact?.who ?? 'the contact'}.`,
  );
  return getRegulator(pool, editionId, institutionId, familyCode);
}

export async function sendTextReminder(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
): Promise<RegulatorEngagementView> {
  const row = await requireRow(pool, editionId, institutionId, familyCode);
  requireActiveLink(row);
  await addRegulatorHistory(
    pool,
    editionId,
    institutionId,
    familyCode,
    `Reminder sent by text to ${row.contact?.phone ?? 'the contact'}.`,
  );
  return getRegulator(pool, editionId, institutionId, familyCode);
}

// ─── Terminal / completion outcomes ────────────────────────────────────────────

/** Declined — a distinct, terminal outcome for the edition (reversible only
 *  via `reopenDeclined`). */
export async function markDeclined(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
): Promise<RegulatorEngagementView> {
  const row = await requireRow(pool, editionId, institutionId, familyCode);
  if (row.status === 'declined') {
    throw new RegulatorEngagementError('Already declined', 'ALREADY_DECLINED');
  }
  if (row.status !== 'invited' && row.status !== 'in_progress') {
    throw new RegulatorEngagementError(
      'Only an invited institution can be recorded as declined',
      'NOT_INVITED',
    );
  }
  await setRegulatorStatus(pool, editionId, institutionId, familyCode, 'declined');
  await addRegulatorHistory(pool, editionId, institutionId, familyCode, 'Declined to take part.');
  return getRegulator(pool, editionId, institutionId, familyCode);
}

/**
 * Reopen a mistakenly-declined role (Phase 19, item 6). Gated by `access:regs`
 * — the same permission Phase 8 already defines for regulator/institution
 * engagement management, previously seeded but unenforced anywhere in this
 * service. Deliberately NO maker-checker: this corrects a routine data-entry
 * mistake, not a critical, hard-to-reverse action. Resets status to
 * `not_started` and clears the dead survey link/lead-time/respondent (the
 * same reset `saveContact`'s cancel-and-restart path uses) — but KEEPS the
 * saved contact, since whoever declined is still the right person to ask
 * again; the study team can re-issue a link immediately without re-entering
 * a name they already have.
 */
export async function reopenDeclined(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
): Promise<RegulatorEngagementView> {
  requirePermission(rbac, 'access:regs');
  const row = await requireRow(pool, editionId, institutionId, familyCode);
  if (row.status !== 'declined') {
    throw new RegulatorEngagementError(
      'Only a declined institution can be reopened',
      'NOT_DECLINED',
    );
  }
  await clearRegulatorSurvey(pool, editionId, institutionId, familyCode);
  await addRegulatorHistory(
    pool,
    editionId,
    institutionId,
    familyCode,
    'Reopened after being recorded as declined — a fresh start, no earlier state carried over.',
  );
  return getRegulator(pool, editionId, institutionId, familyCode);
}

/** Record that the institution submitted (survey received) — status → confirmed. */
export async function markSubmitted(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
): Promise<RegulatorEngagementView> {
  const row = await requireRow(pool, editionId, institutionId, familyCode);
  if (row.status !== 'invited' && row.status !== 'in_progress') {
    throw new RegulatorEngagementError(
      'Only an invited institution can be recorded as submitted',
      'NOT_INVITED',
    );
  }
  await setRegulatorStatus(pool, editionId, institutionId, familyCode, 'confirmed');
  await addRegulatorHistory(
    pool,
    editionId,
    institutionId,
    familyCode,
    'Submitted. Their answers form part of the Institutional Perspectives section.',
  );
  return getRegulator(pool, editionId, institutionId, familyCode);
}

// ─── Free-text history ─────────────────────────────────────────────────────────

/** Append a free-text history entry — no category taxonomy, deliberately. */
export async function recordHistory(
  pool: Pool,
  editionId: string,
  institutionId: string,
  familyCode: InstrumentFamilyCode,
  entry: string,
): Promise<RegulatorEngagementView> {
  await requireRow(pool, editionId, institutionId, familyCode);
  if (entry.trim().length < 4) {
    throw new RegulatorEngagementError('A history entry needs a few words', 'HISTORY_TOO_SHORT');
  }
  await addRegulatorHistory(pool, editionId, institutionId, familyCode, entry.trim());
  return getRegulator(pool, editionId, institutionId, familyCode);
}

export { renderInstitutionalIntro } from './institution-family-service';
