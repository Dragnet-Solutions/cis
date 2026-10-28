import type { Pool, PoolClient } from 'pg';
import {
  resolveFirmContactAddresses,
  batchOutboxCounts,
  getEmailById,
  markEmailFailed,
  type FirmContactAddress,
  listOrganizations,
  listClaimedOrganizationIds,
  listOrganizationIdsWithOutreach,
  getFirmSeatStateCounts,
  countContactConsentByInstrument,
  countUnfinishedReminderContacts,
  listConsentedContactsByInstrument,
  listUnfinishedReminderContacts,
  listRegulatorContacts,
  upsertTemplate,
  getTemplate,
  listTemplates,
  createBatch,
  getBatch,
  listBatches,
  insertRecipient,
  batchDeliveryAggregate,
  orgsSentTemplate,
  orgIdsInvitedThisEdition,
  insertInvitationRequest,
  getInvitationRequest,
  listInvitationRequests,
  resolveInvitationRequestRow,
  listRecipients,
  listBouncedRecipients,
  recordDelivery,
  withTransaction,
  getFirmSegmentContributionCounts,
} from '@cis/db';
import type {
  MessageTemplate,
  MessageAudienceKind,
  MessageBatch,
  MessageRecipient,
  AudienceCategory,
  BatchReport,
  UploadCheckResult,
  InvitationRequestItem,
} from '@cis/shared-types';
import { DomainError } from './errors';
import { queueNotice, queueTemplate, type EmailAction, type NoticeAudience } from './email-content';
import type { MergeFields, TemplateId } from './email-templates';
import { editionForEmail, fmtDate, requestRef, studyDates } from './email-fields';
import {
  invitationLink,
  ensureFirmInvitationRecord,
  isFirmClaimed,
} from './firm-invitation-service';
import { firmPortalLink, siteOrigin, surveyResumeLink, textParagraphs } from './notice-links';

/**
 * UX-OPS-002 — Invitations. Writing to firms, regulators and consented
 * participants. Almost every audience is a QUERY against state the platform
 * already holds, so this service mostly resolves counts/recipients; the only
 * genuinely new mechanics are per-template deduplication, four-check file
 * validation, a pluggable sending abstraction, delivery reporting that degrades
 * gracefully, and the access-request queue.
 *
 * Deliberately NOT here (see README open items and the artefact's own history):
 *   - No register / near-match resolution (removed in the artefact's v3.16) —
 *     an uploaded row that resolves to nothing still sends and shows up in the
 *     delivery report; it is not blocked before sending.
 *   - No respondent-in-progress audience, and nothing that eases chasing an
 *     individual participant (that is UX-OPS-004's job).
 *   - No resend-to-bounced action — a bounce is resolved outside this surface.
 *   - No hardcoded sending provider (behind the SendingService interface).
 *   - markOpened() is NOT wired to a send.
 */

export class InvitationsError extends DomainError {
  constructor(message: string, code = 'INVITATIONS') {
    super(message, code);
  }
}

// ─── Sending service abstraction ────────────────────────────────────────────────

/** Outbox kind of an invitation-batch email; its ref_id is the message_recipients row. */
export const INVITATION_BATCH_EMAIL_KIND = 'invitation-batch';
/** Outbox kind of the email to someone whose invitation request was answered
 *  without a template; its ref_id is the invitation_requests row. */
export const INVITATION_REQUEST_EMAIL_KIND = 'invitation-request-issued';

export interface OutgoingMessage {
  recipientEmail: string | null;
  recipientName?: string | null;
  firmName: string | null;
  organizationId: string | null;
  code: string | null;
  /** The rendered message. */
  subject?: string;
  heading?: string;
  paragraphs?: string[];
  action?: EmailAction;
  /** Who it is for (the BASE layout's small print and sign-off). */
  audience?: NoticeAudience;
  /** One of the designed templates, rendered instead of subject/paragraphs. */
  designed?: { template: TemplateId; fields: MergeFields };
  /** Outbox kind and reference, so the email's delivery can be looked up. */
  kind?: string;
  refId?: string | null;
}

/** `not_sent`: there was no usable address, so nothing was sent. */
export type SendOutcome = 'sent' | 'bounced' | 'not_sent';

/** A sending provider. `name` is recorded on the batch; `send` returns the
 *  initial delivery state. `db` is the caller's pool or transaction. */
export interface SendingService {
  readonly name: string;
  send(message: OutgoingMessage, db?: Pool | PoolClient): Promise<{ deliveryState: SendOutcome }>;
}

/** Records every message as `sent` and sends nothing — for tests. */
export const RECORDING_SENDING_SERVICE: SendingService = {
  name: 'undecided',
  async send() {
    return { deliveryState: 'sent' };
  },
};

/**
 * The real sender: queues the rendered message in the email outbox (inside the
 * caller's transaction when given one), which the API's mail dispatcher
 * delivers through ZeptoMail (SMTP as a fallback; recorded as `logged` when no
 * mail service is configured). A message with no usable address is `not_sent`.
 * Bounces, opens and clicks arrive later via the ZeptoMail webhook.
 */
export class ZeptomailSendingService implements SendingService {
  readonly name = 'zeptomail';
  constructor(private readonly pool?: Pool) {}
  async send(
    message: OutgoingMessage,
    db?: Pool | PoolClient,
  ): Promise<{ deliveryState: SendOutcome }> {
    const to = message.recipientEmail?.trim() ?? '';
    if (!to || !EMAIL_RE.test(to)) return { deliveryState: 'not_sent' };
    const target = db ?? this.pool;
    if (message.designed && message.kind) {
      if (!target) throw new InvitationsError('No database to queue the message in', 'NO_DB');
      await queueTemplate(target, {
        kind: message.kind,
        refId: message.refId ?? null,
        to,
        toName: message.recipientName ?? null,
        template: message.designed.template,
        fields: message.designed.fields,
      });
      return { deliveryState: 'sent' };
    }
    if (!message.subject || !message.paragraphs || !message.kind) {
      throw new InvitationsError('A message must be rendered before it is sent', 'NOT_RENDERED');
    }
    if (!target) throw new InvitationsError('No database to queue the message in', 'NO_DB');
    await queueNotice(target, {
      kind: message.kind,
      refId: message.refId ?? null,
      to,
      toName: message.recipientName ?? null,
      subject: message.subject,
      paragraphs: message.paragraphs,
      ...(message.heading ? { heading: message.heading } : {}),
      ...(message.action ? { action: message.action } : {}),
      ...(message.audience ? { audience: message.audience } : {}),
    });
    return { deliveryState: 'sent' };
  }
}

/** Zeptomail webhook event types mapped to our delivery model. */
type ZeptomailEventType = 'email.delivered' | 'email.bounced' | 'email.opened' | 'email.clicked';

/**
 * Ingest a Zeptomail delivery webhook event, updating the matching recipient in
 * a batch. delivered/bounced set delivery_state; opened/clicked set the
 * timestamps only when reported — so an unreported open stays null (not zero),
 * and a click (a real event) is recorded distinctly. This is how real
 * delivered/bounced/opened/clicked data flows through Phase 9's abstraction into
 * the mission board's condition evaluations.
 */
export async function ingestZeptomailEvent(
  pool: Pool,
  input: { batchId: string; recipientEmail: string; event: ZeptomailEventType; at?: Date },
): Promise<boolean> {
  const recipients = await listRecipients(pool, input.batchId);
  const target = recipients.find(
    (r) => (r.recipientEmail ?? '').toLowerCase() === input.recipientEmail.toLowerCase(),
  );
  if (!target) return false;
  const at = input.at ?? new Date();
  switch (input.event) {
    case 'email.delivered':
      await recordDelivery(pool, target.id, { deliveryState: 'delivered' });
      return true;
    case 'email.bounced':
      await recordDelivery(pool, target.id, { deliveryState: 'bounced' });
      return true;
    case 'email.opened':
      await recordDelivery(pool, target.id, { openedAt: at });
      return true;
    case 'email.clicked':
      await recordDelivery(pool, target.id, { clickedAt: at });
      return true;
    default:
      return false;
  }
}

/** A delivery event reported by ZeptoMail's webhook, by the outbox email id
 *  the dispatcher sent as `client_reference`. */
export type OutboxDeliveryEvent = 'bounced' | 'opened' | 'clicked';

/**
 * Apply a ZeptoMail webhook event to the outbox email it is about: a bounce
 * marks the email failed; for an invitation-batch email the batch recipient
 * gets the bounce/open/click too. Returns false for an unknown reference.
 */
export async function ingestOutboxDeliveryEvent(
  pool: Pool,
  input: { reference: string; event: OutboxDeliveryEvent; at?: Date; detail?: string | null },
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(input.reference)) return false;
  const email = await getEmailById(pool, input.reference);
  if (!email) return false;
  const at = input.at ?? new Date();
  if (input.event === 'bounced') {
    await markEmailFailed(pool, email.id, `Bounced${input.detail ? `: ${input.detail}` : ''}`);
  }
  if (email.kind === INVITATION_BATCH_EMAIL_KIND && email.refId) {
    if (input.event === 'bounced') {
      await recordDelivery(pool, email.refId, { deliveryState: 'bounced' });
    } else if (input.event === 'opened') {
      await recordDelivery(pool, email.refId, { openedAt: at });
    } else {
      await recordDelivery(pool, email.refId, { clickedAt: at });
    }
  }
  return true;
}

// ─── Audiences ─────────────────────────────────────────────────────────────────

const PARTICIPANT_INSTRUMENTS: Record<string, string[]> = {
  retail: ['S4'],
  localinst: ['S5a'],
  foreigninst: ['S5b'],
  allpart: ['S4', 'S5a', 'S5b'],
};

interface FirmState {
  organizationId: string;
  firmName: string;
  invited: boolean;
  claimed: boolean;
  assigned: number;
  complete: number;
  outreach: boolean;
}

/** Resolve every firm's state once; the seven firm audiences are predicates over it. */
async function firmStates(pool: Pool, editionId: string): Promise<FirmState[]> {
  const orgs = (await listOrganizations(pool)).filter((o) => o.orgType === 'firm' && o.isActive);
  const invited = new Set(await orgIdsInvitedThisEdition(pool, editionId));
  const claimed = new Set(await listClaimedOrganizationIds(pool));
  const outreach = new Set(await listOrganizationIdsWithOutreach(pool, editionId));
  const seatCounts = new Map(
    (await getFirmSeatStateCounts(pool, editionId)).map((s) => [s.organizationId, s]),
  );
  return orgs.map((o) => {
    const sc = seatCounts.get(o.id);
    return {
      organizationId: o.id,
      firmName: o.displayName,
      invited: invited.has(o.id),
      claimed: claimed.has(o.id),
      assigned: sc?.assigned ?? 0,
      complete: sc?.complete ?? 0,
      outreach: outreach.has(o.id),
    };
  });
}

const FIRM_AUDIENCE_PREDICATE: Record<string, (f: FirmState) => boolean> = {
  all: () => true,
  newaddr2: (f) => !f.invited,
  unclaimed: (f) => f.invited && !f.claimed,
  noassign: (f) => f.claimed && f.assigned === 0,
  partial: (f) => f.claimed && f.assigned >= 1 && f.complete < 3,
  noreach: (f) => f.complete === 3 && !f.outreach,
  complete: (f) => f.complete === 3 && f.outreach,
};

/**
 * The one-firm audience state (Phase 4/9's noassign/partial/noreach/complete),
 * reused by Phase 18's firm digest "what needs attention" section — no new
 * derivation logic, just the existing predicate applied to a single firm.
 * Returns null for a firm that is unclaimed or not yet invited (states that
 * mean nothing to a digest the firm's own coordinator is reading).
 */
export async function getFirmAudienceState(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<'noassign' | 'partial' | 'noreach' | 'complete' | null> {
  const states = await firmStates(pool, editionId);
  const firm = states.find((f) => f.organizationId === organizationId);
  if (!firm) return null;
  for (const id of ['noassign', 'partial', 'noreach', 'complete'] as const) {
    if (FIRM_AUDIENCE_PREDICATE[id]!(firm)) return id;
  }
  return null;
}

const FIRM_AUDIENCE_META: Array<{ id: string; label: string; sub: string }> = [
  {
    id: 'all',
    label: 'Every firm we hold an address for',
    sub: 'All firms on the register, whatever state.',
  },
  {
    id: 'newaddr2',
    label: 'Firms not yet invited',
    sub: 'On the register, never written to this edition.',
  },
  {
    id: 'unclaimed',
    label: 'Invited, space not claimed',
    sub: 'Delivered, but nobody has set up the firm’s space.',
  },
  {
    id: 'noassign',
    label: 'Space claimed, nobody assigned',
    sub: 'The coordinator is in but has not said who answers.',
  },
  {
    id: 'partial',
    label: 'Assigned, surveys not finished',
    sub: 'At least one of the three surveys is outstanding.',
  },
  {
    id: 'noreach',
    label: 'Claimed, no client outreach yet',
    sub: 'The firm has not sent anything to its clients.',
  },
  {
    id: 'complete',
    label: 'Everything complete',
    sub: 'All three surveys in and clients invited.',
  },
];

const PARTICIPANT_META: Array<{ id: string; label: string; sub: string }> = [
  { id: 'retail', label: 'Retail investors', sub: 'Those who gave a contact detail.' },
  {
    id: 'localinst',
    label: 'Nigerian institutional investors',
    sub: 'Those who gave a contact detail.',
  },
  {
    id: 'foreigninst',
    label: 'Institutional investors abroad',
    sub: 'Those who gave a contact detail.',
  },
  {
    id: 'allpart',
    label: 'Everyone who asked for the report',
    sub: 'Retail and institutional together.',
  },
];

/** All four categories with live counts for the audience picker. */
export async function listAudiences(pool: Pool, editionId: string): Promise<AudienceCategory[]> {
  const firms = await firmStates(pool, editionId);
  const firmAudiences = FIRM_AUDIENCE_META.map((m) => ({
    ...m,
    count: firms.filter(FIRM_AUDIENCE_PREDICATE[m.id] as (f: FirmState) => boolean).length,
  }));

  const consent = await countContactConsentByInstrument(pool, editionId);
  const consentedFor = (codes: string[]): number =>
    codes.reduce((sum, code) => sum + (consent[code]?.consented ?? 0), 0);
  const unfinished = await countUnfinishedReminderContacts(pool, editionId);
  const participantAudiences = PARTICIPANT_META.map((m) => ({
    ...m,
    count: consentedFor(PARTICIPANT_INSTRUMENTS[m.id] as string[]),
    unfinishedCount: (PARTICIPANT_INSTRUMENTS[m.id] as string[]).reduce(
      (sum, code) => sum + (unfinished[code] ?? 0),
      0,
    ),
  }));

  const regs = await listRegulatorContacts(pool);

  return [
    { key: 'firms', label: 'Firms', audiences: firmAudiences },
    {
      key: 'regs',
      label: 'Regulators',
      audiences: [
        {
          id: 'regsall',
          // Counted in market institutions (BUG-05): exactly the ones with a
          // contact on file, named — not a fixed "three regulators".
          label: 'Market institutions with a contact on file',
          sub: regs.length > 0 ? `${regs.map((r) => r.name).join(', ')}.` : 'None on file yet.',
          count: regs.length,
        },
      ],
    },
    {
      key: 'parts',
      label: 'Participants who gave a contact detail',
      audiences: participantAudiences,
    },
    {
      key: 'other',
      label: 'Something else',
      audiences: [
        {
          id: 'upload',
          label: 'A list I upload',
          sub: 'Firms the platform does not know yet.',
          count: null,
        },
      ],
    },
  ];
}

// ─── Templates ─────────────────────────────────────────────────────────────────

export function listMessageTemplates(pool: Pool, editionId: string): Promise<MessageTemplate[]> {
  return listTemplates(pool, editionId);
}

/**
 * Save a template. Placeholder validation is presence, not correctness: a
 * code-bearing firm template (requiresCode) MUST contain {{code}} — a code-less
 * invitation is unusable. Participant / regulator templates have no code concept
 * and are never forced through that check.
 */
export async function saveTemplate(
  pool: Pool,
  data: {
    editionId: string;
    name: string;
    subject: string;
    body: string;
    audienceKind: MessageAudienceKind;
    requiresCode?: boolean;
    createdBy?: string | null;
  },
): Promise<MessageTemplate> {
  if (!data.name.trim()) throw new InvitationsError('A template name is required', 'NAME_REQUIRED');
  if (!data.subject.trim()) throw new InvitationsError('A subject is required', 'SUBJECT_REQUIRED');
  if (!data.body.trim()) throw new InvitationsError('A message body is required', 'BODY_REQUIRED');

  const requiresCode = data.requiresCode ?? data.audienceKind === 'firm';
  // Only firm code-bearing templates are checked; never participant/regulator.
  if (data.audienceKind === 'firm' && requiresCode && !data.body.includes('{{code}}')) {
    throw new InvitationsError(
      'A firm invitation template must include {{code}} — a code-less invitation is unusable',
      'CODE_PLACEHOLDER_REQUIRED',
    );
  }
  return upsertTemplate(pool, {
    editionId: data.editionId,
    name: data.name.trim(),
    subject: data.subject.trim(),
    body: data.body,
    audienceKind: data.audienceKind,
    requiresCode: data.audienceKind === 'firm' ? requiresCode : false,
    createdBy: data.createdBy ?? null,
  });
}

// ─── File validation — exactly four checks (no register-match fifth) ───────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate an uploaded list against exactly four things knowable up front: no
 * address, malformed address, duplicated within the file, and already sent this
 * template (per-template dedup, §4). There is deliberately NO fifth check that
 * resolves a name against the register — that was removed in the artefact's own
 * v3.16, because a row that goes nowhere simply bounces and is visible after the
 * fact.
 */
export async function validateUploadFile(
  pool: Pool,
  input: {
    editionId: string;
    templateId: string;
    rows: Array<{ firmName: string; email: string; organizationId?: string | null }>;
  },
): Promise<UploadCheckResult> {
  const alreadySent = await orgsSentTemplate(pool, input.editionId, input.templateId);
  const problems: UploadCheckResult['problems'] = [];
  const validRows: UploadCheckResult['validRows'] = [];
  const seen = new Set<string>();

  input.rows.forEach((row, i) => {
    const rowNo = i + 1;
    const email = (row.email ?? '').trim().toLowerCase();
    if (!email) {
      problems.push({ kind: 'no_address', row: rowNo, value: row.firmName });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      problems.push({ kind: 'malformed_address', row: rowNo, value: row.email });
      return;
    }
    if (seen.has(email)) {
      problems.push({ kind: 'in_file_duplicate', row: rowNo, value: row.email });
      return;
    }
    if (row.organizationId && alreadySent.has(row.organizationId)) {
      problems.push({ kind: 'already_sent', row: rowNo, value: row.email });
      return;
    }
    seen.add(email);
    validRows.push({ firmName: row.firmName, email: row.email });
  });

  return { validRows, problems };
}

// ─── Send ───────────────────────────────────────────────────────────────────────

export interface SendResult {
  batch: MessageBatch;
  attempted: number;
  /** Queued for delivery. */
  sent: number;
  /** No email address on file — recorded as not sent. */
  notSent: number;
  skippedDuplicates: number;
}

interface BatchTarget {
  recipientEmail: string | null;
  recipientName: string | null;
  firmName: string | null;
  organizationId: string | null;
  /** The firm's link into its space (the {{code}} placeholder), if a firm. */
  link: string | null;
  /** Whether the firm already has a space (its link signs in, not claims). */
  claimed: boolean;
  /** How many of the firm's three surveys are complete (firm audiences). */
  surveysDone?: number;
  /** When the firm's invitation link expires, when it was opened for this email. */
  expiresAt?: Date;
  /** An unclaimed firm with no usable invitation: one is opened for the
   *  recipient's address when the email is sent, and `link` becomes its link. */
  needsInvitation?: boolean;
  /** A reminder's {{survey_link}}: the respondent's own link back into their
   *  unfinished survey (else the public survey entry). */
  surveyLink?: string;
}

/**
 * A participant SURVEY REMINDER ("Retail survey reminder", or any participant
 * template named as a reminder). It goes only to respondents who have not
 * finished — never to anyone who submitted — each with their own resume link
 * (D-03). Every other participant template keeps its audience as it is.
 */
export function isParticipantReminder(
  template: Pick<MessageTemplate, 'name' | 'audienceKind'>,
): boolean {
  return template.audienceKind === 'participant' && /\bremind/i.test(template.name);
}

type FirmLinkPlan = Pick<BatchTarget, 'link' | 'claimed' | 'needsInvitation'>;

/**
 * The firm's link: sign in if it has a space; else its open invitation's link;
 * else (needsInvitation) an invitation is opened for the recipient's address
 * when the email goes out — setting up a space always needs an invitation.
 * Not a firm in the register: the portal's sign-in.
 */
async function planFirmLink(
  pool: Pool,
  portalUrl: string,
  organizationId: string | null,
  contact: FirmContactAddress | undefined,
): Promise<FirmLinkPlan> {
  if (!organizationId) return { link: firmPortalLink(portalUrl), claimed: false };
  if (contact?.source === 'coordinator' || (await isFirmClaimed(pool, organizationId))) {
    return { link: firmPortalLink(portalUrl), claimed: true };
  }
  if (contact?.invitationToken) {
    return { link: invitationLink(portalUrl, contact.invitationToken), claimed: false };
  }
  return { link: null, claimed: false, needsInvitation: true };
}

/**
 * Opens (or reuses / refreshes) the firm's invitation for the target's address
 * inside the sending transaction, WITHOUT its own email — its link goes in the
 * email being sent. Returns the target with its link filled in.
 */
async function withInvitationLink(
  db: Pool,
  t: BatchTarget,
  ctx: { portalUrl: string; editionId: string; actorId: string | null | undefined; via: string },
): Promise<BatchTarget> {
  const email = t.recipientEmail?.trim();
  if (!t.needsInvitation || !t.organizationId || !email || !EMAIL_RE.test(email)) return t;
  if (!ctx.actorId) {
    throw new InvitationsError(
      'Sending a firm its invitation needs the operator who sends it',
      'ACTOR_REQUIRED',
    );
  }
  const inv = await ensureFirmInvitationRecord(db, {
    organizationId: t.organizationId,
    editionId: ctx.editionId,
    email,
    contactName: t.recipientName,
    actorId: ctx.actorId,
    via: ctx.via,
  });
  return {
    ...t,
    link: invitationLink(ctx.portalUrl, inv.token),
    needsInvitation: false,
    expiresAt: inv.expiresAt,
  };
}

const PLACEHOLDER = (name: string) => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');

/**
 * Fill a template's placeholders: {{firm}} (the firm's or regulator's name)
 * and {{code}} / {{link}} (the firm's link into its space — the platform has
 * no typed invitation code; the link is the invitation). With no name,
 * "Dear {{firm}}" becomes "Hello".
 */
export function renderTemplateText(
  text: string,
  vars: {
    firm: string | null;
    link: string | null;
    surveyLink?: string | null;
    closeDate?: string | null;
  },
): string {
  let out = text;
  if (!vars.firm?.trim()) out = out.replace(/Dear\s*\{\{\s*firm\s*\}\}/g, 'Hello');
  return out
    .replace(PLACEHOLDER('firm'), vars.firm?.trim() ?? '')
    .replace(PLACEHOLDER('(?:code|link)'), vars.link ?? '')
    .replace(PLACEHOLDER('survey_link'), vars.surveyLink ?? '')
    .replace(PLACEHOLDER('close_date'), vars.closeDate ?? '');
}

/**
 * The approved design for a batch template, by the template's name: the six
 * seeded firm templates and the retail survey invitation each have one. A
 * template the operators wrote themselves is sent as written, in the shared
 * layout. The designed wording replaces the stored body of a named template.
 */
const DESIGNED_FIRM_TEMPLATES: Readonly<Record<string, TemplateId>> = {
  'first invitation': 'F-01',
  reminder: 'F-02',
  'reissued code': 'F-03',
  'nobody assigned yet': 'F-06',
  'surveys outstanding': 'F-07',
  'invite your clients': 'F-09',
};
const DESIGNED_PARTICIPANT_TEMPLATES: Readonly<Record<string, TemplateId>> = {
  'retail survey invitation': 'P-01',
};

export function designedBatchTemplate(
  template: Pick<MessageTemplate, 'name' | 'audienceKind'>,
  audienceId: string,
): TemplateId | null {
  const name = template.name.trim().toLowerCase();
  if (audienceId in PARTICIPANT_INSTRUMENTS) {
    return template.audienceKind === 'participant'
      ? (DESIGNED_PARTICIPANT_TEMPLATES[name] ?? null)
      : null;
  }
  if (audienceId === 'regsall' || template.audienceKind !== 'firm') return null;
  return DESIGNED_FIRM_TEMPLATES[name] ?? null;
}

/**
 * The bodies these templates were seeded with (test seed and production
 * migration). A stored body that is none of them was edited by the operators:
 * their text then replaces the design's opening paragraphs.
 */
const SEEDED_BODIES: Readonly<Record<string, readonly string[]>> = {
  'first invitation': [
    'Dear {{firm}},\n\nYour firm has a space on the study platform. Open your invitation link to set up your access:\n\n{{code}}',
  ],
  reminder: [
    'Dear {{firm}},\n\nYour invitation to the 2026 benchmark study has not been used yet. Your invitation link is:\n\n{{code}}',
  ],
  'reissued code': ["Dear {{firm}},\n\nHere is your firm's invitation link again:\n\n{{code}}"],
  'nobody assigned yet': [
    'Dear {{firm}},\n\nYour space is set up, but the three surveys have not been assigned to anyone yet.',
  ],
  'surveys outstanding': [
    'Dear {{firm}},\n\nAt least one of your three surveys is still outstanding.',
  ],
  'invite your clients': [
    'Dear {{firm}},\n\nYour firm has not yet invited its own clients to take part.',
  ],
  'retail survey invitation': [
    'Dear participant,\n\nYou have been selected to complete a brief survey as part of the 2026 benchmark study. Please follow the link to complete your survey: {{survey_link}}\n\nThank you.',
    'You have been invited to share your experience for the independent Nigerian Capital Market Brokerage Benchmark.\n\nYour answers are anonymous. No broker is told whether you took part, and your name is never shared with any firm.\n\nStart your survey: {{survey_link}}\n\nIf you did not expect this invitation, you can disregard this message.',
  ],
};

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Whether the operators changed a seeded template's body. */
export function operatorEditedBody(template: Pick<MessageTemplate, 'name' | 'body'>): boolean {
  const seeded = SEEDED_BODIES[template.name.trim().toLowerCase()];
  if (!seeded) return true;
  return !seeded.some((b) => normalise(b) === normalise(template.body));
}

/** The public survey's entry, where an invited investor starts. */
const retailSurveyLink = (portalUrl: string) => `${siteOrigin(portalUrl)}/survey`;

interface BatchRenderContext {
  db: Pool;
  audienceId: string;
  portalUrl: string;
  edition: Awaited<ReturnType<typeof editionForEmail>>;
}

const AUDIENCE_OF: Record<MessageAudienceKind, NoticeAudience> = {
  firm: 'firm',
  participant: 'investor',
  regulator: 'institution',
  upload: 'firm',
};

/** The rendered email for one batch recipient: its designed template, else the operators' text. */
async function renderBatchMessage(
  template: MessageTemplate,
  t: BatchTarget,
  ctx: BatchRenderContext,
): Promise<Pick<OutgoingMessage, 'subject' | 'paragraphs' | 'action' | 'audience' | 'designed'>> {
  const designed = designedBatchTemplate(template, ctx.audienceId);
  if (designed) {
    const firm = t.firmName?.trim() || 'your firm';
    const dates = studyDates(ctx.edition);
    const portalLink = t.link ?? firmPortalLink(ctx.portalUrl);
    let fields: MergeFields;
    if (designed === 'P-01') {
      fields = {
        survey_link: t.surveyLink ?? retailSurveyLink(ctx.portalUrl),
        close_date: dates.close_date,
        edition: ctx.edition?.label,
      };
    } else {
      fields = {
        contact_name: t.recipientName?.trim() || firm,
        firm,
        portal_link: portalLink,
        // There is no typed code: the firm's personal link is its invitation.
        code: portalLink,
        open_date: dates.open_date,
        close_date: dates.close_date,
        surveys_done: t.surveysDone ?? 0,
        expires_on: t.expiresAt && !t.claimed ? fmtDate(t.expiresAt) : null,
        edition: ctx.edition?.label,
      };
      if (designed === 'F-09') {
        const c =
          t.organizationId && ctx.edition
            ? await getFirmSegmentContributionCounts(ctx.db, ctx.edition.id, t.organizationId)
            : null;
        fields['investor_responses'] = c
          ? c.retail + c.localInstitutional + c.foreignInstitutional
          : 0;
      }
    }
    if (operatorEditedBody(template)) {
      // The operators' own words, inside the approved design.
      fields['body'] = textParagraphs(
        renderTemplateText(template.body, {
          firm: t.firmName,
          link: portalLink,
          surveyLink: t.surveyLink ?? retailSurveyLink(ctx.portalUrl),
          closeDate: dates.close_date,
        }),
      );
    }
    return { designed: { template: designed, fields } };
  }
  const vars = {
    firm: t.firmName,
    link: t.link,
    surveyLink: t.surveyLink ?? retailSurveyLink(ctx.portalUrl),
  };
  const bodyHasLink = /\{\{\s*(?:code|link)\s*\}\}/.test(template.body);
  return {
    subject: renderTemplateText(template.subject, vars),
    paragraphs: textParagraphs(renderTemplateText(template.body, vars)),
    audience: AUDIENCE_OF[template.audienceKind],
    // A template that does not carry the link itself still gets a button to it.
    ...(t.link && !bodyHasLink
      ? {
          action: {
            label: t.claimed ? "Sign in to your firm's space" : "Set up your firm's space",
            url: t.link,
          },
        }
      : {}),
  };
}

/**
 * Send a batch. Resolves recipients from the audience (or the uploaded rows),
 * applies per-template deduplication (a firm never gets the SAME template twice
 * across any earlier batch in this edition — but may get different templates),
 * renders the template for each recipient and sends it through the sending
 * service (by default: queued in the email outbox for ZeptoMail).
 *
 * A firm audience writes to the firm's lead coordinator, else another active
 * coordinator, else its open firm invitation's address. A recipient with no
 * address is recorded as `not_sent` — never counted as sent, and not treated
 * as already sent this template, so a later batch reaches it.
 */
export async function sendBatch(
  pool: Pool,
  input: {
    editionId: string;
    templateId: string;
    audienceId: string;
    uploadRows?: Array<{ firmName: string; email: string; organizationId?: string | null }>;
    sentBy?: string | null;
    service?: SendingService;
    /** The public site's address (PORTAL_URL), for the links in the email. */
    portalUrl?: string;
  },
): Promise<SendResult> {
  const template = await getTemplate(pool, input.templateId);
  if (!template || template.editionId !== input.editionId) {
    throw new InvitationsError('Template not found for this edition', 'TEMPLATE_NOT_FOUND');
  }
  const service = input.service ?? new ZeptomailSendingService();
  const portalUrl = siteOrigin(input.portalUrl);
  const alreadySent = await orgsSentTemplate(pool, input.editionId, input.templateId);
  const edition = await editionForEmail(pool, input.editionId);

  // Resolve the target recipient set.
  const targets: BatchTarget[] = [];
  let audienceLabel = input.audienceId;

  if (input.audienceId === 'upload') {
    const rows = input.uploadRows ?? [];
    const contacts = await resolveFirmContactAddresses(pool, [
      ...new Set(rows.map((r) => r.organizationId).filter((id): id is string => !!id)),
    ]);
    for (const r of rows) {
      const orgId = r.organizationId ?? null;
      const plan = await planFirmLink(
        pool,
        portalUrl,
        orgId,
        orgId ? contacts.get(orgId) : undefined,
      );
      targets.push({
        recipientEmail: r.email,
        recipientName: null,
        firmName: r.firmName,
        organizationId: orgId,
        ...plan,
      });
    }
    audienceLabel = 'Uploaded list';
  } else if (input.audienceId === 'regsall') {
    for (const r of await listRegulatorContacts(pool)) {
      targets.push({
        recipientEmail: r.email,
        recipientName: null,
        firmName: r.name,
        organizationId: null,
        link: null,
        claimed: false,
      });
    }
    audienceLabel = 'Market institutions with a contact on file';
  } else if (input.audienceId in PARTICIPANT_INSTRUMENTS && isParticipantReminder(template)) {
    // A survey reminder: only those who have not finished, each linked back
    // into their own survey. Anyone who submitted is never reminded.
    for (const c of await listUnfinishedReminderContacts(
      pool,
      input.editionId,
      PARTICIPANT_INSTRUMENTS[input.audienceId] as string[],
    )) {
      targets.push({
        recipientEmail: c.email,
        recipientName: null,
        firmName: null,
        organizationId: null,
        link: null,
        claimed: false,
        surveyLink: surveyResumeLink(portalUrl, c.recoveryToken),
      });
    }
    audienceLabel = `${
      PARTICIPANT_META.find((m) => m.id === input.audienceId)?.label ?? input.audienceId
    } who have not finished`;
  } else if (input.audienceId in PARTICIPANT_INSTRUMENTS) {
    const contacts = await listConsentedContactsByInstrument(
      pool,
      input.editionId,
      PARTICIPANT_INSTRUMENTS[input.audienceId] as string[],
    );
    for (const c of contacts) {
      targets.push({
        recipientEmail: c.email,
        recipientName: null,
        firmName: null,
        organizationId: null,
        link: null,
        claimed: false,
      });
    }
    audienceLabel =
      PARTICIPANT_META.find((m) => m.id === input.audienceId)?.label ?? input.audienceId;
  } else {
    // A firm audience.
    const predicate = FIRM_AUDIENCE_PREDICATE[input.audienceId];
    if (!predicate) throw new InvitationsError('Unknown audience', 'UNKNOWN_AUDIENCE');
    const firms = (await firmStates(pool, input.editionId)).filter(predicate);
    const contacts = await resolveFirmContactAddresses(
      pool,
      firms.map((f) => f.organizationId),
    );
    for (const f of firms) {
      const contact = contacts.get(f.organizationId);
      const plan = await planFirmLink(pool, portalUrl, f.organizationId, contact);
      targets.push({
        recipientEmail: contact?.email ?? null,
        recipientName: contact?.name ?? null,
        firmName: f.firmName,
        organizationId: f.organizationId,
        surveysDone: f.complete,
        ...plan,
      });
    }
    audienceLabel =
      FIRM_AUDIENCE_META.find((m) => m.id === input.audienceId)?.label ?? input.audienceId;
  }

  // Per-template dedup: drop firm targets already sent this template.
  let skippedDuplicates = 0;
  const deliverable = targets.filter((t) => {
    if (t.organizationId && alreadySent.has(t.organizationId)) {
      skippedDuplicates += 1;
      return false;
    }
    return true;
  });

  return withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const batch = await createBatch(c, {
      editionId: input.editionId,
      templateId: input.templateId,
      audienceId: input.audienceId,
      audienceLabel,
      sendingService: service.name,
      sentBy: input.sentBy ?? null,
    });
    let sent = 0;
    let notSent = 0;
    for (const target of deliverable) {
      const email = target.recipientEmail?.trim() || null;
      const t = await withInvitationLink(c, target, {
        portalUrl,
        editionId: input.editionId,
        actorId: input.sentBy,
        via: INVITATION_BATCH_EMAIL_KIND,
      });
      const recipient = await insertRecipient(c, {
        batchId: batch.id,
        editionId: input.editionId,
        organizationId: t.organizationId,
        recipientEmail: email,
        firmName: t.firmName,
        code: t.link,
        deliveryState: email ? 'sent' : 'not_sent',
      });
      let outcome: SendOutcome = 'not_sent';
      if (email) {
        outcome = (
          await service.send(
            {
              recipientEmail: email,
              recipientName: t.recipientName,
              firmName: t.firmName,
              organizationId: t.organizationId,
              code: t.link,
              kind: INVITATION_BATCH_EMAIL_KIND,
              refId: recipient.id,
              ...(await renderBatchMessage(template, t, {
                db: c,
                audienceId: input.audienceId,
                portalUrl,
                edition,
              })),
            },
            client,
          )
        ).deliveryState;
        if (outcome !== 'sent') {
          await recordDelivery(c, recipient.id, { deliveryState: outcome });
        }
      }
      if (outcome === 'not_sent') notSent += 1;
      else sent += 1;
    }
    return { batch, attempted: targets.length, sent, notSent, skippedDuplicates };
  });
}

// ─── Delivery reporting ──────────────────────────────────────────────────────────

export async function getBatches(pool: Pool, editionId: string): Promise<MessageBatch[]> {
  return listBatches(pool, editionId);
}

/**
 * A batch's delivery report. sent/accepted/bounced always populate — "accepted"
 * means the mail service took the message and it has not bounced (ZeptoMail
 * sends no delivered event, so nothing here claims inbox delivery). opened and
 * clicked populate only when the configured provider reported them — otherwise
 * `opensReported`/`clicksReported` are false and the surface renders those
 * columns as absent, never as zero. accepted-never-opened and opened-not-clicked
 * are kept distinct (different failure modes: channel/spam vs. content).
 */
export async function getBatchReport(pool: Pool, batchId: string): Promise<BatchReport> {
  const batch = await getBatch(pool, batchId);
  if (!batch) throw new InvitationsError('Batch not found', 'NOT_FOUND');
  const template = await getTemplate(pool, batch.templateId);
  const agg = await batchDeliveryAggregate(pool, batchId);
  return {
    batch,
    templateName: template?.name ?? '—',
    firms: agg.firms,
    accepted: agg.accepted,
    bounced: agg.bounced,
    opened: agg.opened,
    clicked: agg.clicked,
    opensReported: agg.opensReported,
    clicksReported: agg.clicksReported,
    acceptedNeverOpened: agg.acceptedNeverOpened,
    openedNotClicked: agg.openedNotClicked,
    notSent: agg.notSent,
    outbox: await batchOutboxCounts(pool, batchId, INVITATION_BATCH_EMAIL_KIND),
  };
}

/** A batch's bounced addresses, for the "list the addresses that bounced"
 *  view — there is deliberately no resend action anywhere on this surface. */
export function getBouncedRecipients(pool: Pool, batchId: string): Promise<MessageRecipient[]> {
  return listBouncedRecipients(pool, batchId);
}

// ─── Access-request queue (the operational half of Phase 4's request flow) ─────

/**
 * Persist a request-an-invitation submission (from UX-FRM-001) so it surfaces in
 * this queue. Resolves the firm name to a register organization when possible;
 * an unmatched name is still accepted (kept as free text).
 */
export async function submitInvitationRequest(
  pool: Pool,
  input: {
    editionId: string;
    firmName: string;
    requesterName: string;
    role?: string | null;
    email: string;
    phone?: string | null;
    flag?: string | null;
    organizationId?: string | null;
  },
): Promise<InvitationRequestItem> {
  return insertInvitationRequest(pool, {
    editionId: input.editionId,
    organizationId: input.organizationId ?? null,
    firmName: input.firmName,
    requesterName: input.requesterName,
    role: input.role ?? null,
    email: input.email,
    phone: input.phone ?? null,
    flag: input.flag ?? null,
  });
}

export function getInvitationRequests(
  pool: Pool,
  editionId: string,
  includeResolved = false,
): Promise<InvitationRequestItem[]> {
  return listInvitationRequests(pool, editionId, { includeResolved });
}

/** Outbox kinds of the answers to a request for an invitation; ref_id is the
 *  invitation_requests row. Approved (F-11) goes with the invitation itself;
 *  declined (F-12) carries the reason. */
export const INVITATION_REQUEST_APPROVED_EMAIL_KIND = 'invitation-request-approved';
export const INVITATION_REQUEST_DECLINED_EMAIL_KIND = 'invitation-request-declined';

/**
 * Resolve a queued request — by issuing the firm's invitation to the
 * requester, by declining it with a reason, or by marking it done without
 * either. Each closes the queue item.
 *
 * Issuing tells the requester the firm has been added (F-11) and emails them
 * their firm's link — sign-in if the firm already has a space (then no F-11:
 * nothing was added), else its open invitation, else a new invitation opened
 * for the requester's address: rendered from the reissue template when one is
 * given — recorded as a one-recipient batch, kind 'invitation-batch' — else
 * the firm invitation design (F-01) of kind 'invitation-request-issued'.
 *
 * Declining needs a reason, which the requester is sent (F-12). Marking done
 * sends nothing.
 */
export async function resolveInvitationRequest(
  pool: Pool,
  input: {
    requestId: string;
    resolution: 'code_issued' | 'marked_done' | 'declined';
    resolvedBy?: string | null;
    reissueTemplateId?: string;
    /** Required to decline: told to the requester. */
    declineReason?: string | null;
    /** The public site's address (PORTAL_URL), for the link in the email. */
    portalUrl?: string;
  },
): Promise<InvitationRequestItem> {
  const req = await getInvitationRequest(pool, input.requestId);
  if (!req) throw new InvitationsError('Request not found', 'NOT_FOUND');
  if (req.resolved) throw new InvitationsError('Request is already resolved', 'ALREADY_RESOLVED');
  const declineReason = input.declineReason?.trim() ?? '';
  if (input.resolution === 'declined' && declineReason.length < 4) {
    throw new InvitationsError(
      'Give the reason for declining: the requester is told it.',
      'DECLINE_REASON_REQUIRED',
    );
  }

  const template =
    input.resolution === 'code_issued' && input.reissueTemplateId
      ? await getTemplate(pool, input.reissueTemplateId)
      : null;
  const portalUrl = siteOrigin(input.portalUrl);
  const contact = req.organizationId
    ? (await resolveFirmContactAddresses(pool, [req.organizationId])).get(req.organizationId)
    : undefined;
  if (input.resolution === 'code_issued' && !req.organizationId) {
    throw new InvitationsError(
      'This request’s firm is not in the register, so there is no firm to invite. Add the firm to the register first, or mark the request done.',
      'FIRM_NOT_MATCHED',
    );
  }
  const plan = await planFirmLink(pool, portalUrl, req.organizationId, contact);
  const edition = await editionForEmail(pool, req.editionId);
  const to = req.email.trim();
  const canEmail = EMAIL_RE.test(to);
  const ref = requestRef(req.id);

  return withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    if (input.resolution === 'declined' && canEmail) {
      await queueTemplate(client, {
        kind: INVITATION_REQUEST_DECLINED_EMAIL_KIND,
        refId: req.id,
        to,
        toName: req.requesterName,
        template: 'F-12',
        fields: {
          requester_name: req.requesterName,
          firm: req.firmName,
          request_ref: ref,
          decline_reason: declineReason,
        },
      });
    }
    if (input.resolution === 'code_issued') {
      // An unclaimed firm with no open invitation: open one for the requester.
      const resolved = await withInvitationLink(
        c,
        {
          recipientEmail: req.email,
          recipientName: req.requesterName,
          firmName: req.firmName,
          organizationId: req.organizationId,
          ...plan,
        },
        {
          portalUrl,
          editionId: req.editionId,
          actorId: input.resolvedBy,
          via: INVITATION_REQUEST_EMAIL_KIND,
        },
      );
      const claimed = resolved.claimed;
      const link = resolved.link ?? firmPortalLink(portalUrl);
      // F-11 first: it says the invitation follows in a separate email.
      if (!claimed && canEmail) {
        await queueTemplate(client, {
          kind: INVITATION_REQUEST_APPROVED_EMAIL_KIND,
          refId: req.id,
          to,
          toName: req.requesterName,
          template: 'F-11',
          fields: { requester_name: req.requesterName, firm: req.firmName, request_ref: ref },
        });
      }
      if (template) {
        const service = new ZeptomailSendingService();
        const batch = await createBatch(c, {
          editionId: req.editionId,
          templateId: template.id,
          audienceId: 'request',
          audienceLabel: `Reissue to ${req.firmName}`,
          sendingService: service.name,
          sentBy: input.resolvedBy ?? null,
        });
        const recipient = await insertRecipient(c, {
          batchId: batch.id,
          editionId: req.editionId,
          organizationId: req.organizationId,
          recipientEmail: req.email,
          firmName: req.firmName,
          code: link,
        });
        const target: BatchTarget = {
          recipientEmail: req.email,
          recipientName: req.requesterName,
          firmName: req.firmName,
          organizationId: req.organizationId,
          link,
          claimed,
        };
        const { deliveryState } = await service.send(
          {
            recipientEmail: req.email,
            recipientName: req.requesterName,
            firmName: req.firmName,
            organizationId: req.organizationId,
            code: link,
            kind: INVITATION_BATCH_EMAIL_KIND,
            refId: recipient.id,
            ...(await renderBatchMessage(template, target, {
              db: c,
              audienceId: 'request',
              portalUrl,
              edition,
            })),
          },
          client,
        );
        if (deliveryState !== 'sent') await recordDelivery(c, recipient.id, { deliveryState });
      } else if (canEmail && !claimed) {
        await queueTemplate(client, {
          kind: INVITATION_REQUEST_EMAIL_KIND,
          refId: req.id,
          to,
          toName: req.requesterName,
          template: 'F-01',
          fields: {
            contact_name: req.requesterName,
            firm: req.firmName,
            code: link,
            portal_link: link,
            ...studyDates(edition),
            expires_on: resolved.expiresAt ? fmtDate(resolved.expiresAt) : null,
            edition: edition?.label,
          },
        });
      } else if (canEmail) {
        await queueNotice(client, {
          kind: INVITATION_REQUEST_EMAIL_KIND,
          refId: req.id,
          to,
          toName: req.requesterName,
          audience: 'firm',
          subject: `Your invitation to the 2026 CIS-Dragnet Benchmark Study — ${req.firmName}`,
          label: 'Your request',
          heading: `${req.firmName} already has its space`,
          paragraphs: [
            `Dear ${req.requesterName},`,
            `Thank you for asking to take part in the 2026 CIS-Dragnet Benchmark Study for ${req.firmName} (ref ${ref}).`,
            `Your firm has already set up its space. Its coordinators sign in with their email address and PIN; ask one of them to add you to your firm's team.`,
          ],
          action: { label: 'Go to the firm portal', url: link },
        });
      }
    }
    return resolveInvitationRequestRow(c, input.requestId, {
      resolution: input.resolution,
      resolvedBy: input.resolvedBy ?? null,
      declineReason: input.resolution === 'declined' ? declineReason : null,
    });
  });
}

/** Resolve a submitted firm name to a register organization id, if one matches
 *  exactly (case-insensitive). Used when persisting a request. */
export async function resolveFirmNameToOrg(pool: Pool, firmName: string): Promise<string | null> {
  const orgs = await listOrganizations(pool);
  const match = orgs.find(
    (o) => o.orgType === 'firm' && o.displayName.toLowerCase() === firmName.trim().toLowerCase(),
  );
  return match ? match.id : null;
}

/**
 * Resolve several firm names at once — the same exact, case-insensitive match
 * as `resolveFirmNameToOrg`, but fetching the register once instead of once
 * per name. Used by the invitations upload flow so an uploaded CSV's rows can
 * carry a real `organizationId` before validation, which is what makes the
 * fourth file-validation check (a firm already sent this template) able to
 * fire for an upload the way it already does for a firm-audience send — a
 * name with no match resolves to null, same as the single-name function.
 */
export async function resolveFirmNamesToOrgs(
  pool: Pool,
  firmNames: string[],
): Promise<Record<string, string | null>> {
  const orgs = await listOrganizations(pool);
  const byLowerName = new Map(
    orgs.filter((o) => o.orgType === 'firm').map((o) => [o.displayName.toLowerCase(), o.id]),
  );
  const result: Record<string, string | null> = {};
  for (const name of firmNames) {
    result[name] = byLowerName.get(name.trim().toLowerCase()) ?? null;
  }
  return result;
}
