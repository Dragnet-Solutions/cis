import { Pool } from 'pg';
import {
  listOrganizations,
  listClaimedOrganizationIds,
  listOrganizationIdsWithOutreach,
  getFirmSeatStateCounts,
  countContactConsentByInstrument,
  listConsentedContactsByInstrument,
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

// ─── Sending service abstraction (provider is a config decision) ───────────────

export interface OutgoingMessage {
  recipientEmail: string | null;
  firmName: string | null;
  organizationId: string | null;
  code: string | null;
}

/** A sending provider. CIS domain / Dragnet domain / TrustedMail (and the PRD's
 *  Zeptomail) are all candidates — none is decided, so any can be plugged in.
 *  `name` is recorded on the batch; `send` returns the initial delivery state. */
export interface SendingService {
  readonly name: string;
  send(message: OutgoingMessage): Promise<{ deliveryState: 'sent' | 'bounced' }>;
}

/**
 * The default provider used until a real one is configured. It records the
 * message as `sent` and reports nothing further — delivery, bounces, opens and
 * clicks arrive later via the provider's callbacks (recordDelivery). It performs
 * no external I/O, so it is safe in every environment.
 */
export const RECORDING_SENDING_SERVICE: SendingService = {
  name: 'undecided',
  async send() {
    return { deliveryState: 'sent' };
  },
};

/**
 * Zeptomail — the RESOLVED sending provider (Phase 10; the mission-board brief
 * and UX-OPS-001's contract both confirm it, superseding UX-OPS-002's stale
 * "undecided" note). Zeptomail reports delivered/bounced/opened/clicked, the
 * full set the board depends on. No credential is hardcoded: the API token is
 * read from `ZEPTOMAIL_API_TOKEN` at construction. When no token is configured
 * (dev/test/CI), it records `sent` and performs no network I/O — the real send
 * would POST to Zeptomail's transactional API here, and delivery/bounce/open/
 * click events return asynchronously via the webhook (ingestZeptomailEvent).
 */
export class ZeptomailSendingService implements SendingService {
  readonly name = 'zeptomail';
  private readonly token: string | null;
  constructor(token?: string | null) {
    this.token = token ?? process.env['ZEPTOMAIL_API_TOKEN'] ?? null;
  }
  async send(_message: OutgoingMessage): Promise<{ deliveryState: 'sent' | 'bounced' }> {
    // Real integration point. With a token, POST to Zeptomail's send API here
    // (the abstraction keeps that provider-specific code isolated). Without one,
    // record as sent — the webhook carries the actual outcome either way.
    return { deliveryState: 'sent' };
  }
  get configured(): boolean {
    return this.token !== null;
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
  const participantAudiences = PARTICIPANT_META.map((m) => ({
    ...m,
    count: consentedFor(PARTICIPANT_INSTRUMENTS[m.id] as string[]),
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
          label: 'All three regulators',
          sub: 'SEC, NGX and CSCS.',
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
  sent: number;
  skippedDuplicates: number;
}

/**
 * Send a batch. Resolves recipients from the audience (or the uploaded rows),
 * applies per-template deduplication (a firm never gets the SAME template twice
 * across any earlier batch in this edition — but may get different templates),
 * and records each recipient through the pluggable sending service.
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
  },
): Promise<SendResult> {
  const template = await getTemplate(pool, input.templateId);
  if (!template || template.editionId !== input.editionId) {
    throw new InvitationsError('Template not found for this edition', 'TEMPLATE_NOT_FOUND');
  }
  // Zeptomail is the resolved provider (Phase 10); it degrades to recording-only
  // when no token is configured, so tests and CI stay hermetic.
  const service = input.service ?? new ZeptomailSendingService();
  const alreadySent = await orgsSentTemplate(pool, input.editionId, input.templateId);

  // Resolve the target recipient set.
  const targets: OutgoingMessage[] = [];
  let audienceLabel = input.audienceId;

  if (input.audienceId === 'upload') {
    for (const r of input.uploadRows ?? []) {
      targets.push({
        recipientEmail: r.email,
        firmName: r.firmName,
        organizationId: r.organizationId ?? null,
        code: null,
      });
    }
    audienceLabel = 'Uploaded list';
  } else if (input.audienceId === 'regsall') {
    for (const r of await listRegulatorContacts(pool)) {
      targets.push({ recipientEmail: r.email, firmName: r.name, organizationId: null, code: null });
    }
    audienceLabel = 'All three regulators';
  } else if (input.audienceId in PARTICIPANT_INSTRUMENTS) {
    const contacts = await listConsentedContactsByInstrument(
      pool,
      input.editionId,
      PARTICIPANT_INSTRUMENTS[input.audienceId] as string[],
    );
    for (const c of contacts) {
      targets.push({ recipientEmail: c.email, firmName: null, organizationId: null, code: null });
    }
    audienceLabel =
      PARTICIPANT_META.find((m) => m.id === input.audienceId)?.label ?? input.audienceId;
  } else {
    // A firm audience.
    const predicate = FIRM_AUDIENCE_PREDICATE[input.audienceId];
    if (!predicate) throw new InvitationsError('Unknown audience', 'UNKNOWN_AUDIENCE');
    const firms = (await firmStates(pool, input.editionId)).filter(predicate);
    for (const f of firms) {
      targets.push({
        recipientEmail: null, // resolved from the register by the sending layer
        firmName: f.firmName,
        organizationId: f.organizationId,
        // A code-bearing template carries the firm's invitation code.
        code: template.requiresCode ? `INV-${f.organizationId.slice(0, 8).toUpperCase()}` : null,
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
    for (const t of deliverable) {
      const outcome = await service.send(t);
      await insertRecipient(c, {
        batchId: batch.id,
        editionId: input.editionId,
        organizationId: t.organizationId,
        recipientEmail: t.recipientEmail,
        firmName: t.firmName,
        code: t.code,
        deliveryState: outcome.deliveryState,
      });
      sent += 1;
    }
    return { batch, attempted: targets.length, sent, skippedDuplicates };
  });
}

// ─── Delivery reporting ──────────────────────────────────────────────────────────

export async function getBatches(pool: Pool, editionId: string): Promise<MessageBatch[]> {
  return listBatches(pool, editionId);
}

/**
 * A batch's delivery report. sent/delivered/bounced always populate. opened and
 * clicked populate only when the configured provider reported them — otherwise
 * `opensReported`/`clicksReported` are false and the surface renders those
 * columns as absent, never as zero. delivered-never-opened and opened-not-clicked
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
    delivered: agg.delivered,
    bounced: agg.bounced,
    opened: agg.opened,
    clicked: agg.clicked,
    opensReported: agg.opensReported,
    clicksReported: agg.clicksReported,
    deliveredNeverOpened: agg.deliveredNeverOpened,
    openedNotClicked: agg.openedNotClicked,
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

/**
 * Resolve a queued request — either by issuing a code (records a reissue batch
 * to the requester) or by marking it done without issuing one. Both close the
 * queue item.
 */
export async function resolveInvitationRequest(
  pool: Pool,
  input: {
    requestId: string;
    resolution: 'code_issued' | 'marked_done';
    resolvedBy?: string | null;
    reissueTemplateId?: string;
  },
): Promise<InvitationRequestItem> {
  const req = await getInvitationRequest(pool, input.requestId);
  if (!req) throw new InvitationsError('Request not found', 'NOT_FOUND');
  if (req.resolved) throw new InvitationsError('Request is already resolved', 'ALREADY_RESOLVED');

  if (input.resolution === 'code_issued') {
    // Record the reissue as a one-recipient batch to the requester's address, if
    // a reissue template was supplied. The code itself is issued out-of-band; the
    // batch is the delivery record.
    if (input.reissueTemplateId) {
      const template = await getTemplate(pool, input.reissueTemplateId);
      if (template) {
        const batch = await createBatch(pool, {
          editionId: req.editionId,
          templateId: template.id,
          audienceId: 'request',
          audienceLabel: `Reissue to ${req.firmName}`,
          sentBy: input.resolvedBy ?? null,
        });
        await insertRecipient(pool, {
          batchId: batch.id,
          editionId: req.editionId,
          organizationId: req.organizationId,
          recipientEmail: req.email,
          firmName: req.firmName,
          code: req.organizationId
            ? `INV-${req.organizationId.slice(0, 8).toUpperCase()}`
            : 'INV-NEW',
        });
      }
    }
  }
  return resolveInvitationRequestRow(pool, input.requestId, {
    resolution: input.resolution,
    resolvedBy: input.resolvedBy ?? null,
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
