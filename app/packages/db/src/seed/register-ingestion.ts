import { Pool } from 'pg';
import type { InstrumentType, QuestionKind, QuestionScope } from '@cis/shared-types';
import {
  createInstrumentDefinition,
  createInstrumentDefinitionVersion,
} from '../queries/instrument-definitions';
import { createInstrumentQuestion } from '../queries/instrument-questions';

/**
 * Phase 21 §3 — the survey-content ingestion boundary.
 *
 * `REOPEN_QUEUE.md` (`SURVEY-REGISTER-EXPORT`) and the Engineering Handoff
 * Readiness Inventory §2.2 both record the same gap: no machine-readable,
 * controlled Survey Instruments Register export exists yet. Product owns
 * delivering one, versioned and mapped to approved question IDs, "consumable
 * through `bindData(payload)`" — the renderer's runtime content contract
 * (`CIS_Engineering_Screen_Stitching_Guide.md` §4). Engineering's job now is
 * to build the PATH that export will travel through, not to transcribe the
 * PDF into code and not to wait.
 *
 * This module IS that path: a versioned payload shape plus a real
 * loader/importer that validates structure on the way in — question IDs,
 * kind, scope, uniqueness — the same discipline any real content-ingestion
 * pipeline applies, rather than a bare migration INSERT. `register.ts`'s
 * `seedSurveyRegister` is now a thin caller that feeds today's known-good
 * content through this exact loader as the INTERIM payload (`source:
 * 'interim_seed'`). When the real controlled export lands, binding it is a
 * data swap — a new payload through the same `importSurveyRegister` call —
 * never a code change.
 */

const CONTROLLED_QUESTION_KINDS: readonly QuestionKind[] = [
  'scale',
  'single',
  'yesno',
  'select',
  'multi',
  'rank',
  'grid',
  'open',
];
const CONTROLLED_QUESTION_SCOPES: readonly QuestionScope[] = ['shared', 'firm_specific'];

export const REGISTER_PAYLOAD_SCHEMA_VERSION = '1.0';

/**
 * `interim_seed`: known-good content already cross-verified against
 * `QUESTION_SCOPE_MAPPING.md` and the signed PDF (Phase 2), extended the same
 * way for Family D (Phase 19) — loaded through this boundary, but NOT the
 * approved machine-readable Register export.
 * `approved_export`: the controlled, versioned, Product-delivered export
 * this boundary exists to receive. Nothing in this codebase produces this
 * value yet — set it only when binding a real export.
 */
export type RegisterPayloadSource = 'interim_seed' | 'approved_export';

export interface RegisterPayloadItem {
  question_id: string;
  kind: string;
  text: string;
  scope: string;
  is_drg_ops?: boolean;
  scored?: boolean;
  options?: string[];
  scale_min?: number;
  scale_max?: number;
  scale_anchors?: string;
  rank_exactly_n?: number;
  select_up_to_n?: number;
  has_optional_comment?: number;
  answer_optional?: number;
  conditional_detail_on?: string;
  select_then_greatest?: number;
  grid_rows?: string[];
  grid_dimensions?: Record<string, string[]>;
  grid_scale?: { min: number; max: number };
}

/** The `bindData(payload)`-shaped import: everything the loader needs to
 *  populate `instrument_questions` for one or more instruments, plus enough
 *  provenance to tell interim content apart from an approved export. */
export interface RegisterImportPayload {
  schemaVersion: string;
  source: RegisterPayloadSource;
  /** Human-readable provenance — filename, date, or export identifier. */
  sourceLabel: string;
  instruments: Record<string, RegisterPayloadItem[]>;
}

export class RegisterIngestionError extends Error {
  constructor(
    message: string,
    public readonly code = 'REGISTER_INGESTION_INVALID',
  ) {
    super(message);
    this.name = 'RegisterIngestionError';
  }
}

function fail(message: string): never {
  throw new RegisterIngestionError(message);
}

/**
 * Validate a payload's structure before anything touches the database.
 * Throws `RegisterIngestionError` naming the exact instrument/item/field on
 * the first problem found — a real content-ingestion pipeline fails loudly
 * and specifically, not with a bare Postgres constraint violation.
 */
export function validateRegisterPayload(payload: unknown): RegisterImportPayload {
  if (typeof payload !== 'object' || payload === null) {
    fail('Register payload must be an object');
  }
  const p = payload as Record<string, unknown>;

  if (typeof p['schemaVersion'] !== 'string' || p['schemaVersion'].trim() === '') {
    fail('Register payload: "schemaVersion" must be a non-empty string');
  }
  if (p['source'] !== 'interim_seed' && p['source'] !== 'approved_export') {
    fail(
      `Register payload: "source" must be "interim_seed" or "approved_export", got ${JSON.stringify(p['source'])}`,
    );
  }
  if (typeof p['sourceLabel'] !== 'string' || p['sourceLabel'].trim() === '') {
    fail('Register payload: "sourceLabel" must be a non-empty string');
  }
  if (typeof p['instruments'] !== 'object' || p['instruments'] === null) {
    fail('Register payload: "instruments" must be an object keyed by instrument code');
  }

  const instruments = p['instruments'] as Record<string, unknown>;
  for (const [instrumentCode, rawItems] of Object.entries(instruments)) {
    if (!Array.isArray(rawItems)) {
      fail(`Register payload: instrument "${instrumentCode}" must map to an array of items`);
    }
    const seenIds = new Set<string>();
    for (const [index, rawItem] of rawItems.entries()) {
      validateItem(rawItem, instrumentCode, index, seenIds);
    }
  }

  return {
    schemaVersion: p['schemaVersion'] as string,
    source: p['source'] as RegisterPayloadSource,
    sourceLabel: p['sourceLabel'] as string,
    instruments: instruments as Record<string, RegisterPayloadItem[]>,
  };
}

function validateItem(
  rawItem: unknown,
  instrumentCode: string,
  index: number,
  seenIds: Set<string>,
): asserts rawItem is RegisterPayloadItem {
  const where = `instrument "${instrumentCode}", item ${index}`;
  if (typeof rawItem !== 'object' || rawItem === null) {
    fail(`Register payload: ${where} must be an object`);
  }
  const item = rawItem as Record<string, unknown>;

  if (typeof item['question_id'] !== 'string' || item['question_id'].trim() === '') {
    fail(`Register payload: ${where} — "question_id" must be a non-empty string`);
  }
  const questionId = item['question_id'] as string;
  if (seenIds.has(questionId)) {
    fail(
      `Register payload: instrument "${instrumentCode}" has a duplicate question_id "${questionId}"`,
    );
  }
  seenIds.add(questionId);

  if (typeof item['text'] !== 'string' || item['text'].trim() === '') {
    fail(`Register payload: ${where} (${questionId}) — "text" must be a non-empty string`);
  }
  if (!CONTROLLED_QUESTION_KINDS.includes(item['kind'] as QuestionKind)) {
    fail(
      `Register payload: ${where} (${questionId}) — "kind" must be one of ${CONTROLLED_QUESTION_KINDS.join(', ')}, got ${JSON.stringify(item['kind'])}`,
    );
  }
  if (!CONTROLLED_QUESTION_SCOPES.includes(item['scope'] as QuestionScope)) {
    fail(
      `Register payload: ${where} (${questionId}) — "scope" must be one of ${CONTROLLED_QUESTION_SCOPES.join(', ')}, got ${JSON.stringify(item['scope'])}`,
    );
  }
}

/** Per-instrument display metadata the loader needs — same shape
 *  `register.ts`'s `INSTRUMENT_META` already carries. */
export interface RegisterInstrumentMeta {
  code: string;
  name: string;
  respondent: string;
  feeds: string;
  scored: boolean;
  instrumentType: InstrumentType;
}

/**
 * The real loader: validate the payload, then populate `instrument_questions`
 * (and the owning `instrument_definitions`/`instrument_definition_versions`
 * rows) from it. Assumes a clean/truncated schema, exactly like the seed path
 * it replaces. Every `instrument_definition_versions.schema_snapshot` row
 * records the payload's `source`/`schemaVersion`/`sourceLabel`, so a query
 * against the live database can always tell interim content apart from an
 * approved export — never silently conflate the two.
 */
export async function importSurveyRegister(
  pool: Pool,
  payload: unknown,
  instrumentMeta: readonly RegisterInstrumentMeta[],
  createdBy?: string | null,
): Promise<Record<string, string>> {
  const validated = validateRegisterPayload(payload);

  const ids: Record<string, string> = {};
  for (const meta of instrumentMeta) {
    const items = validated.instruments[meta.code] ?? [];
    const def = await createInstrumentDefinition(pool, {
      code: meta.code,
      name: meta.name,
      instrumentType: meta.instrumentType,
      scored: meta.scored,
    });
    ids[meta.code] = def.id;
    await createInstrumentDefinitionVersion(pool, {
      instrumentDefinitionId: def.id,
      versionNumber: 1,
      schemaSnapshot: {
        respondent: meta.respondent,
        feeds: meta.feeds,
        questionCount: items.length,
        placeholder: false,
        registerPayloadSource: validated.source,
        registerPayloadSchemaVersion: validated.schemaVersion,
        source: validated.sourceLabel,
      },
      ...(createdBy ? { createdBy } : {}),
    });

    let order = 0;
    for (const raw of items) {
      order += 1;
      await createInstrumentQuestion(pool, {
        instrumentDefinitionId: def.id,
        questionCode: raw.question_id,
        promptText: raw.text,
        kind: raw.kind as QuestionKind,
        scope: raw.scope as QuestionScope,
        displayOrder: order,
        scored: raw.scored ?? true,
        isDrgOps: raw.is_drg_ops ?? false,
        isPlaceholder: false,
        options: raw.options ?? null,
        scaleMin: raw.scale_min ?? null,
        scaleMax: raw.scale_max ?? null,
        scaleAnchors: raw.scale_anchors ?? null,
        rankExactlyN: raw.rank_exactly_n ?? null,
        selectUpToN: raw.select_up_to_n ?? null,
        hasOptionalComment: raw.has_optional_comment === 1,
        answerOptional: raw.answer_optional === 1,
        conditionalDetailOn: raw.conditional_detail_on ?? null,
        selectThenGreatest: raw.select_then_greatest === 1,
        gridRows: raw.grid_rows ?? null,
        gridDimensions: raw.grid_dimensions ?? null,
        gridScale: raw.grid_scale ?? null,
      });
    }
  }
  return ids;
}
