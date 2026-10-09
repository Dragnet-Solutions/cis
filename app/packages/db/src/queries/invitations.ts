import { Pool } from 'pg';
import type {
  MessageTemplate,
  MessageAudienceKind,
  MessageBatch,
  MessageRecipient,
  MessageDeliveryState,
  InvitationRequestItem,
} from '@cis/shared-types';
import { query } from '../client';

/**
 * Invitations estate (UX-OPS-002): templates, batches, per-recipient delivery
 * records, the access-request queue, and the provisional regulator-contact stub.
 * Audience RESOLUTION is a domain concern (queries against Phase 3/4 state); this
 * module owns only the messaging tables themselves.
 */

// ─── message_templates ───────────────────────────────────────────────────────

interface RawTemplateRow {
  id: string;
  edition_id: string;
  name: string;
  subject: string;
  body: string;
  audience_kind: MessageAudienceKind;
  requires_code: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapTemplate(r: RawTemplateRow): MessageTemplate {
  return {
    id: r.id,
    editionId: r.edition_id,
    name: r.name,
    subject: r.subject,
    body: r.body,
    audienceKind: r.audience_kind,
    requiresCode: r.requires_code,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function upsertTemplate(
  pool: Pool,
  data: {
    editionId: string;
    name: string;
    subject: string;
    body: string;
    audienceKind: MessageAudienceKind;
    requiresCode: boolean;
    createdBy?: string | null;
  },
): Promise<MessageTemplate> {
  const res = await query<RawTemplateRow>(
    pool,
    `INSERT INTO message_templates
       (edition_id, name, subject, body, audience_kind, requires_code, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (edition_id, name) DO UPDATE
       SET subject = EXCLUDED.subject, body = EXCLUDED.body,
           audience_kind = EXCLUDED.audience_kind, requires_code = EXCLUDED.requires_code,
           updated_at = NOW()
     RETURNING *`,
    [
      data.editionId,
      data.name,
      data.subject,
      data.body,
      data.audienceKind,
      data.requiresCode,
      data.createdBy ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Template upsert returned no rows');
  return mapTemplate(row);
}

export async function getTemplate(pool: Pool, id: string): Promise<MessageTemplate | null> {
  const res = await query<RawTemplateRow>(pool, 'SELECT * FROM message_templates WHERE id = $1', [
    id,
  ]);
  const row = res.rows[0];
  return row ? mapTemplate(row) : null;
}

export async function getTemplateByName(pool: Pool, name: string): Promise<MessageTemplate | null> {
  const res = await query<RawTemplateRow>(
    pool,
    'SELECT * FROM message_templates WHERE name = $1 ORDER BY created_at LIMIT 1',
    [name],
  );
  const row = res.rows[0];
  return row ? mapTemplate(row) : null;
}

export async function listTemplatesByAudience(
  pool: Pool,
  audienceKind: MessageAudienceKind,
): Promise<MessageTemplate[]> {
  const res = await query<RawTemplateRow>(
    pool,
    'SELECT * FROM message_templates WHERE audience_kind = $1 ORDER BY created_at',
    [audienceKind],
  );
  return res.rows.map(mapTemplate);
}

export async function listTemplates(pool: Pool, editionId: string): Promise<MessageTemplate[]> {
  const res = await query<RawTemplateRow>(
    pool,
    'SELECT * FROM message_templates WHERE edition_id = $1 ORDER BY created_at',
    [editionId],
  );
  return res.rows.map(mapTemplate);
}

// ─── message_batches ─────────────────────────────────────────────────────────

interface RawBatchRow {
  id: string;
  edition_id: string;
  template_id: string;
  audience_id: string;
  audience_label: string;
  sending_service: string;
  sent_by: string | null;
  sent_at: Date;
  created_at: Date;
}

function mapBatch(r: RawBatchRow): MessageBatch {
  return {
    id: r.id,
    editionId: r.edition_id,
    templateId: r.template_id,
    audienceId: r.audience_id,
    audienceLabel: r.audience_label,
    sendingService: r.sending_service,
    sentBy: r.sent_by,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  };
}

export async function createBatch(
  pool: Pool,
  data: {
    editionId: string;
    templateId: string;
    audienceId: string;
    audienceLabel: string;
    sendingService?: string;
    sentBy?: string | null;
  },
): Promise<MessageBatch> {
  const res = await query<RawBatchRow>(
    pool,
    `INSERT INTO message_batches
       (edition_id, template_id, audience_id, audience_label, sending_service, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      data.editionId,
      data.templateId,
      data.audienceId,
      data.audienceLabel,
      data.sendingService ?? 'undecided',
      data.sentBy ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Batch insert returned no rows');
  return mapBatch(row);
}

export async function getBatch(pool: Pool, id: string): Promise<MessageBatch | null> {
  const res = await query<RawBatchRow>(pool, 'SELECT * FROM message_batches WHERE id = $1', [id]);
  const row = res.rows[0];
  return row ? mapBatch(row) : null;
}

export async function listBatches(pool: Pool, editionId: string): Promise<MessageBatch[]> {
  const res = await query<RawBatchRow>(
    pool,
    'SELECT * FROM message_batches WHERE edition_id = $1 ORDER BY sent_at DESC',
    [editionId],
  );
  return res.rows.map(mapBatch);
}

// ─── message_recipients ──────────────────────────────────────────────────────

interface RawRecipientRow {
  id: string;
  batch_id: string;
  edition_id: string;
  organization_id: string | null;
  recipient_email: string | null;
  firm_name: string | null;
  code: string | null;
  delivery_state: MessageDeliveryState;
  opened_at: Date | null;
  clicked_at: Date | null;
  created_at: Date;
}

function mapRecipient(r: RawRecipientRow): MessageRecipient {
  return {
    id: r.id,
    batchId: r.batch_id,
    editionId: r.edition_id,
    organizationId: r.organization_id,
    recipientEmail: r.recipient_email,
    firmName: r.firm_name,
    code: r.code,
    deliveryState: r.delivery_state,
    openedAt: r.opened_at,
    clickedAt: r.clicked_at,
    createdAt: r.created_at,
  };
}

export async function insertRecipient(
  pool: Pool,
  data: {
    batchId: string;
    editionId: string;
    organizationId?: string | null;
    recipientEmail?: string | null;
    firmName?: string | null;
    code?: string | null;
    deliveryState?: MessageDeliveryState;
  },
): Promise<MessageRecipient> {
  const res = await query<RawRecipientRow>(
    pool,
    `INSERT INTO message_recipients
       (batch_id, edition_id, organization_id, recipient_email, firm_name, code, delivery_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      data.batchId,
      data.editionId,
      data.organizationId ?? null,
      data.recipientEmail ?? null,
      data.firmName ?? null,
      data.code ?? null,
      data.deliveryState ?? 'sent',
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Recipient insert returned no rows');
  return mapRecipient(row);
}

export async function listRecipients(pool: Pool, batchId: string): Promise<MessageRecipient[]> {
  const res = await query<RawRecipientRow>(
    pool,
    'SELECT * FROM message_recipients WHERE batch_id = $1 ORDER BY created_at',
    [batchId],
  );
  return res.rows.map(mapRecipient);
}

/** Bounced addresses for a batch (for the "list the addresses that bounced"
 *  action — there is deliberately no resend action). */
export async function listBouncedRecipients(
  pool: Pool,
  batchId: string,
): Promise<MessageRecipient[]> {
  const res = await query<RawRecipientRow>(
    pool,
    `SELECT * FROM message_recipients WHERE batch_id = $1 AND delivery_state = 'bounced' ORDER BY created_at`,
    [batchId],
  );
  return res.rows.map(mapRecipient);
}

/**
 * Update a recipient's delivery outcome. Delivered/bounced always meaningful;
 * opened/clicked only set when the sending service reports them (leaving them
 * null otherwise, which the report reads as "not reported", not "zero").
 */
export async function recordDelivery(
  pool: Pool,
  recipientId: string,
  data: { deliveryState?: MessageDeliveryState; openedAt?: Date | null; clickedAt?: Date | null },
): Promise<void> {
  await query(
    pool,
    `UPDATE message_recipients
        SET delivery_state = COALESCE($2, delivery_state),
            opened_at      = COALESCE($3, opened_at),
            clicked_at     = COALESCE($4, clicked_at)
      WHERE id = $1`,
    [recipientId, data.deliveryState ?? null, data.openedAt ?? null, data.clickedAt ?? null],
  );
}

/** The set of organization ids that already received a given template in ANY
 *  batch this edition — the per-template dedup check (§4). */
export async function orgsSentTemplate(
  pool: Pool,
  editionId: string,
  templateId: string,
): Promise<Set<string>> {
  const res = await query<{ organization_id: string }>(
    pool,
    `SELECT DISTINCT r.organization_id
       FROM message_recipients r
       JOIN message_batches b ON b.id = r.batch_id
      WHERE r.edition_id = $1 AND b.template_id = $2 AND r.organization_id IS NOT NULL`,
    [editionId, templateId],
  );
  return new Set(res.rows.map((x) => x.organization_id));
}

/** Distinct organization ids written to in ANY batch this edition — for the
 *  "not yet invited" / "invited but unclaimed" audiences. */
export async function orgIdsInvitedThisEdition(pool: Pool, editionId: string): Promise<string[]> {
  const res = await query<{ organization_id: string }>(
    pool,
    `SELECT DISTINCT organization_id FROM message_recipients
      WHERE edition_id = $1 AND organization_id IS NOT NULL`,
    [editionId],
  );
  return res.rows.map((r) => r.organization_id);
}

/** Aggregate a batch's delivery counts, and whether opens/clicks were reported
 *  at all (any non-null across the batch's recipients). */
export async function batchDeliveryAggregate(
  pool: Pool,
  batchId: string,
): Promise<{
  firms: number;
  delivered: number;
  bounced: number;
  opened: number;
  clicked: number;
  opensReported: boolean;
  clicksReported: boolean;
  deliveredNeverOpened: number;
  openedNotClicked: number;
}> {
  const res = await query<{
    firms: string;
    delivered: string;
    bounced: string;
    opened: string;
    clicked: string;
    opens_reported: boolean;
    clicks_reported: boolean;
    delivered_never_opened: string;
    opened_not_clicked: string;
  }>(
    pool,
    `SELECT
       COUNT(*)::text AS firms,
       COUNT(*) FILTER (WHERE delivery_state = 'delivered')::text AS delivered,
       COUNT(*) FILTER (WHERE delivery_state = 'bounced')::text AS bounced,
       COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::text AS opened,
       COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::text AS clicked,
       (COUNT(*) FILTER (WHERE opened_at IS NOT NULL) > 0) AS opens_reported,
       (COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) > 0) AS clicks_reported,
       COUNT(*) FILTER (WHERE delivery_state = 'delivered' AND opened_at IS NULL)::text AS delivered_never_opened,
       COUNT(*) FILTER (WHERE opened_at IS NOT NULL AND clicked_at IS NULL)::text AS opened_not_clicked
     FROM message_recipients WHERE batch_id = $1`,
    [batchId],
  );
  const r = res.rows[0];
  const num = (v: string | undefined) => parseInt(v ?? '0', 10);
  return {
    firms: num(r?.firms),
    delivered: num(r?.delivered),
    bounced: num(r?.bounced),
    opened: num(r?.opened),
    clicked: num(r?.clicked),
    opensReported: !!r?.opens_reported,
    clicksReported: !!r?.clicks_reported,
    deliveredNeverOpened: num(r?.delivered_never_opened),
    openedNotClicked: num(r?.opened_not_clicked),
  };
}

// ─── invitation_requests ─────────────────────────────────────────────────────

interface RawRequestRow {
  id: string;
  edition_id: string;
  organization_id: string | null;
  firm_name: string;
  requester_name: string;
  role: string | null;
  email: string;
  phone: string | null;
  flag: string | null;
  resolved: boolean;
  resolution: 'code_issued' | 'marked_done' | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

function mapRequest(r: RawRequestRow): InvitationRequestItem {
  return {
    id: r.id,
    editionId: r.edition_id,
    organizationId: r.organization_id,
    firmName: r.firm_name,
    requesterName: r.requester_name,
    role: r.role,
    email: r.email,
    phone: r.phone,
    flag: r.flag,
    resolved: r.resolved,
    resolution: r.resolution,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
}

export async function insertInvitationRequest(
  pool: Pool,
  data: {
    editionId: string;
    organizationId?: string | null;
    firmName: string;
    requesterName: string;
    role?: string | null;
    email: string;
    phone?: string | null;
    flag?: string | null;
  },
): Promise<InvitationRequestItem> {
  const res = await query<RawRequestRow>(
    pool,
    `INSERT INTO invitation_requests
       (edition_id, organization_id, firm_name, requester_name, role, email, phone, flag)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.editionId,
      data.organizationId ?? null,
      data.firmName,
      data.requesterName,
      data.role ?? null,
      data.email,
      data.phone ?? null,
      data.flag ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Invitation request insert returned no rows');
  return mapRequest(row);
}

export async function getInvitationRequest(
  pool: Pool,
  id: string,
): Promise<InvitationRequestItem | null> {
  const res = await query<RawRequestRow>(pool, 'SELECT * FROM invitation_requests WHERE id = $1', [
    id,
  ]);
  const row = res.rows[0];
  return row ? mapRequest(row) : null;
}

export async function listInvitationRequests(
  pool: Pool,
  editionId: string,
  opts: { includeResolved?: boolean } = {},
): Promise<InvitationRequestItem[]> {
  const res = await query<RawRequestRow>(
    pool,
    opts.includeResolved
      ? 'SELECT * FROM invitation_requests WHERE edition_id = $1 ORDER BY created_at DESC'
      : 'SELECT * FROM invitation_requests WHERE edition_id = $1 AND resolved = FALSE ORDER BY created_at DESC',
    [editionId],
  );
  return res.rows.map(mapRequest);
}

export async function resolveInvitationRequestRow(
  pool: Pool,
  id: string,
  data: { resolution: 'code_issued' | 'marked_done'; resolvedBy: string | null },
): Promise<InvitationRequestItem> {
  const res = await query<RawRequestRow>(
    pool,
    `UPDATE invitation_requests
        SET resolved = TRUE, resolution = $2, resolved_by = $3, resolved_at = NOW()
      WHERE id = $1 AND resolved = FALSE
      RETURNING *`,
    [id, data.resolution, data.resolvedBy],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`Invitation request ${id} not found or already resolved`);
  return mapRequest(row);
}

// ─── regulator_contacts (provisional, pending UX-OPS-007) ─────────────────────

export async function listRegulatorContacts(
  pool: Pool,
): Promise<Array<{ orgCode: string; name: string; email: string }>> {
  const res = await query<{ org_code: string; name: string; email: string }>(
    pool,
    'SELECT org_code, name, email FROM regulator_contacts ORDER BY org_code',
  );
  return res.rows.map((r) => ({ orgCode: r.org_code, name: r.name, email: r.email }));
}

/** Seed the six per-state templates and the three regulator contacts. Idempotent. */
export async function seedInvitationDefaults(pool: Pool, editionId: string): Promise<void> {
  const templates: Array<{
    name: string;
    subject: string;
    body: string;
    audienceKind: MessageAudienceKind;
    requiresCode: boolean;
  }> = [
    {
      name: 'First invitation',
      subject: 'Your firm has been invited to the 2026 benchmark',
      body: 'Dear {{firm}},\n\nYour firm has a space on the study platform. Your invitation code is {{code}}.\n\nUse it once to set up your access.',
      audienceKind: 'firm',
      requiresCode: true,
    },
    {
      name: 'Reminder',
      subject: 'Your firm has not yet claimed its space',
      body: 'Dear {{firm}},\n\nYour invitation to the 2026 benchmark study has not been used yet. Your code is {{code}}.',
      audienceKind: 'firm',
      requiresCode: true,
    },
    {
      name: 'Reissued code',
      subject: 'A new invitation code for your firm',
      body: 'Dear {{firm}},\n\nA new invitation code has been issued for your firm: {{code}}.\n\nAny earlier code no longer works.',
      audienceKind: 'firm',
      requiresCode: true,
    },
    {
      name: 'Nobody assigned yet',
      subject: 'Who at your firm is answering?',
      body: 'Dear {{firm}},\n\nYour space is set up, but the three surveys have not been assigned to anyone yet.',
      audienceKind: 'firm',
      requiresCode: false,
    },
    {
      name: 'Surveys outstanding',
      subject: 'Your firm has surveys still to complete',
      body: 'Dear {{firm}},\n\nAt least one of your three surveys is still outstanding.',
      audienceKind: 'firm',
      requiresCode: false,
    },
    {
      name: 'Invite your clients',
      subject: 'Your clients have not been invited yet',
      body: 'Dear {{firm}},\n\nYour firm has not yet invited its own clients to take part.',
      audienceKind: 'firm',
      requiresCode: false,
    },
  ];
  for (const t of templates) {
    await upsertTemplate(pool, { editionId, ...t });
  }
  const regs: Array<{ code: string; name: string; email: string }> = [
    { code: 'SEC', name: 'Securities and Exchange Commission', email: 'contact@sec.example' },
    { code: 'NGX', name: 'Nigerian Exchange Group', email: 'contact@ngx.example' },
    { code: 'CSCS', name: 'Central Securities Clearing System', email: 'contact@cscs.example' },
  ];
  for (const r of regs) {
    await query(
      pool,
      `INSERT INTO regulator_contacts (org_code, name, email)
       VALUES ($1,$2,$3) ON CONFLICT (org_code) DO NOTHING`,
      [r.code, r.name, r.email],
    );
  }
}
