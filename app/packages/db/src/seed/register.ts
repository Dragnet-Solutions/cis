import { Pool } from 'pg';
import type { InstrumentType } from '@cis/shared-types';
import {
  importSurveyRegister,
  REGISTER_PAYLOAD_SCHEMA_VERSION,
  type RegisterImportPayload,
} from './register-ingestion';
// Controlled Survey Register content, loaded as DATA (not a hardcoded literal in
// application/renderer code — SV-010 §5 / Phase 2 §6). This is the seed source;
// the content authority is the table it populates.
//
// Phase 21 §3: this content now flows through the `bindData(payload)`-shaped
// ingestion boundary (`register-ingestion.ts`) as the INTERIM payload
// (`source: 'interim_seed'`), rather than being inserted directly. Binding the
// real controlled Register export later is a data swap through the same
// `importSurveyRegister` call, never a code change — see that module's header.
//
// ⚠️ COMPLIANCE FOLLOW-UP BEFORE PRODUCTION EDITION FREEZE ⚠️
// FUNCTIONAL_FREEZE_SURVEY_ESTATE.md records that the three institutional Q5
// items — I-SEC-Q5, I-NGX-Q5, I-CSCS-Q5 — were still marked PENDING correction
// in the live controlled Register as of the 2026-08-20 freeze, pending the
// capability-assessment wording agreed with CIS. This seed file's Q5 wording may
// or may not be the corrected version. Do NOT finalize these three items into a
// production edition freeze without a compliance sign-off against the current
// controlled Register. The SV-010 gate test will flag any drift from this seed,
// but it cannot tell you which side of that correction the seed fell on.
import registerJson from './survey-register-seed.json';

interface RawItem {
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
  scope_gate?: { close_on: string[]; decision: string };
}

/**
 * Instrument-level metadata carried IN the Register data for instruments added
 * after the original nine/ten (whose metadata predates this and stays in
 * `BASE_INSTRUMENT_META` below). Adding a further institutional instrument is
 * a data change to `survey-register-seed.json` only: its items under
 * `instruments`, and an entry here.
 */
interface RawInstrumentMeta {
  name: string;
  respondent: string;
  feeds: string;
  scored: boolean;
  instrument_type: InstrumentType;
  /** Document metadata, recorded on the instrument version's snapshot. */
  strap?: string;
  audience?: string;
  length?: string;
  source?: string;
  registration_note?: string;
  item_notes?: Record<string, string>;
}

interface RawRegister {
  instrument_meta?: Record<string, RawInstrumentMeta>;
  instruments: Record<string, RawItem[]>;
}

const REGISTER = registerJson as unknown as RawRegister;

/** Instrument display metadata (not part of the question Register itself). */
interface InstrumentMeta {
  name: string;
  respondent: string;
  feeds: string;
  scored: boolean;
  instrumentType: InstrumentType;
  /** Extra document metadata recorded on the version snapshot. */
  details?: Record<string, unknown>;
}

/** Canonical instrument order and display metadata for the original ten. */
const BASE_INSTRUMENT_META: ReadonlyArray<{ code: string } & InstrumentMeta> = [
  {
    code: 'S1',
    name: 'Managing Director / CEO survey',
    respondent: 'Managing Director / CEO',
    feeds: 'OMI · DMI · SEI',
    scored: true,
    instrumentType: 'survey',
  },
  {
    code: 'S2',
    name: 'Compliance Lead survey',
    respondent: 'Compliance Lead',
    feeds: 'OMI · SEI',
    scored: true,
    instrumentType: 'survey',
  },
  {
    code: 'S3',
    name: 'Operations Lead survey',
    respondent: 'Operations Lead',
    feeds: 'OMI · DMI · SEI',
    scored: true,
    instrumentType: 'survey',
  },
  {
    code: 'S4',
    name: 'Retail investor survey',
    respondent: 'Retail investor',
    feeds: 'IEI · ICI · SEI',
    scored: true,
    instrumentType: 'survey',
  },
  {
    code: 'S5a',
    name: 'Local institutional investor survey',
    respondent: 'Local institutional investor',
    feeds: 'IEI · ICI · SEI',
    scored: true,
    instrumentType: 'survey',
  },
  {
    code: 'S5b',
    name: 'Foreign institutional investor survey',
    respondent: 'Foreign institutional investor',
    feeds: 'IEI · ICI · SEI',
    scored: true,
    instrumentType: 'survey',
  },
  {
    code: 'I-SEC',
    name: 'Securities and Exchange Commission',
    respondent: 'Securities and Exchange Commission',
    feeds: 'Contextual only',
    scored: false,
    instrumentType: 'regulator',
  },
  {
    code: 'I-NGX',
    name: 'Nigerian Exchange Limited',
    respondent: 'Nigerian Exchange Limited',
    feeds: 'Contextual only',
    scored: false,
    instrumentType: 'regulator',
  },
  {
    code: 'I-CSCS',
    name: 'Central Securities Clearing System',
    respondent: 'Central Securities Clearing System',
    feeds: 'Contextual only',
    scored: false,
    instrumentType: 'regulator',
  },
  // Family D — Depository / Securities-account Infrastructure (Phase 19,
  // CIS_Institutional_Instrument_Families_Register_Extension v1.1). One
  // instrument per FAMILY, not per institution — FMDQ Depository Limited and
  // CSCS's depository role both use this same instrument.
  {
    code: 'I-DEP',
    name: 'Depository / Securities-account Infrastructure',
    respondent: 'Depository institution',
    feeds: 'Contextual only',
    scored: false,
    instrumentType: 'regulator',
  },
];

/** Instruments whose metadata is carried in the Register data itself, in the
 *  data's own order (I-LCFE, I-NASD, I-FMDQ, ...). */
const DATA_INSTRUMENT_META: ReadonlyArray<{ code: string } & InstrumentMeta> = Object.entries(
  REGISTER.instrument_meta ?? {},
).map(([code, m]) => {
  const { name, respondent, feeds, scored, instrument_type, ...details } = m;
  return { code, name, respondent, feeds, scored, instrumentType: instrument_type, details };
});

/** Canonical instrument order and display metadata. */
export const INSTRUMENT_META: ReadonlyArray<{ code: string } & InstrumentMeta> = [
  ...BASE_INSTRUMENT_META,
  ...DATA_INSTRUMENT_META.filter((d) => !BASE_INSTRUMENT_META.some((b) => b.code === d.code)),
];

export const INSTRUMENT_CODES: readonly string[] = INSTRUMENT_META.map((m) => m.code);

/**
 * D-16 — instruments kept in the Register for provenance but RETIRED: never
 * offered for freeze, frozen into an edition, rendered, or reported.
 * I-DEP (Family D, Depository / Securities-account Infrastructure) is in no
 * approved document: UX-OPS-007 v2.10 maps one registered institution to one
 * bespoke instrument with no new role family, the six market institutions are
 * SEC, NGX, CSCS, LCFE, NASD and FMDQ, and the CIS-approved LCFE/NASD/FMDQ
 * document records a separate depository questionnaire as premature.
 * Seeded rows are stamped `instrument_definitions.retired_at`; existing
 * databases by migration 20261023200000_retire-cscs-depository.js.
 */
export const RETIRED_INSTRUMENT_CODES: readonly string[] = ['I-DEP'];

/** The instruments in use: the Register less the retired ones. */
export const ACTIVE_INSTRUMENT_CODES: readonly string[] = INSTRUMENT_CODES.filter(
  (c) => !RETIRED_INSTRUMENT_CODES.includes(c),
);

/**
 * Total controlled items across the Register (a fixed, verified count).
 * 90 → 95 in Phase 19: Family D (Depository / Securities-account
 * Infrastructure) adds five new institutional/contextual items (D-Q1–D-Q5),
 * same category as the existing 15 Family A/B/C items — neither DRG-OPS nor
 * firm-specific, so those counts (7 and 11/6/3) are unaffected. This is an
 * intentional content-estate change, not a regression — see SV-010 test.
 * 95 → 113 (Sept 2026 client decision): I-LCFE, I-NASD and I-FMDQ add six
 * items each (Q0 scope gate + Q1–Q5), again institutional/contextual only.
 */
export const REGISTER_ITEM_COUNT = 113;

/**
 * The marker for Register content that has not been supplied yet. Any item
 * whose text or options contain it blocks the instrument freeze
 * (instrument-service `requestFreeze`/`decideFreeze`), so placeholder content
 * can never reach a launched edition.
 */
export const REGISTER_TODO_MARKER = '[TODO]';

/**
 * Seed the controlled Survey Register through the Phase 21 §3 ingestion
 * boundary: wraps `survey-register-seed.json` as an `interim_seed`-sourced
 * `RegisterImportPayload` and hands it to `importSurveyRegister`, which
 * validates it and performs the same writes (ten instrument definitions, a v1
 * version each, all 95 question rows) that this function used to do directly.
 * Assumes a clean/truncated schema. Returns a map of instrument code →
 * definition id.
 */
export async function seedSurveyRegister(
  pool: Pool,
  createdBy?: string | null,
): Promise<Record<string, string>> {
  const payload: RegisterImportPayload = {
    schemaVersion: REGISTER_PAYLOAD_SCHEMA_VERSION,
    source: 'interim_seed',
    sourceLabel: 'Survey Register (survey_register_seed.json, 2026-08-20)',
    instruments: REGISTER.instruments as RegisterImportPayload['instruments'],
  };
  const ids = await importSurveyRegister(pool, payload, INSTRUMENT_META, createdBy);
  await pool.query(
    `UPDATE instrument_definitions SET retired_at = NOW()
      WHERE code = ANY($1) AND retired_at IS NULL`,
    [RETIRED_INSTRUMENT_CODES],
  );
  return ids;
}

/** The raw Register content, exposed for the SV-010 comparison gate test. */
export function getRegisterFixture(): RawRegister {
  return REGISTER;
}
