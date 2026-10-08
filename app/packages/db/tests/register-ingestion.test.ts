/**
 * Phase 21 §3 — the survey-content ingestion boundary.
 *
 * `validateRegisterPayload` must fail loudly and specifically on a malformed
 * payload (bad kind, bad scope, duplicate question_id, missing fields) rather
 * than letting bad content reach the database. `importSurveyRegister` must
 * write through cleanly for a valid payload and record its provenance
 * (source / schemaVersion / sourceLabel) on the instrument version row, so an
 * interim seed and a future approved export are never silently conflated.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  validateRegisterPayload,
  importSurveyRegister,
  RegisterIngestionError,
  REGISTER_PAYLOAD_SCHEMA_VERSION,
  getLatestInstrumentVersion,
  listInstrumentDefinitions,
  getInstrumentItems,
  type RegisterImportPayload,
  type RegisterInstrumentMeta,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from './setup';

let pool: Pool;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
});
afterAll(async () => {
  await closeTestPool();
});

const VALID_ITEM = {
  question_id: 'T-Q1',
  kind: 'yesno',
  text: 'Is this a valid item?',
  scope: 'shared',
};

function validPayload(overrides: Partial<RegisterImportPayload> = {}): RegisterImportPayload {
  return {
    schemaVersion: REGISTER_PAYLOAD_SCHEMA_VERSION,
    source: 'interim_seed',
    sourceLabel: 'unit test fixture',
    instruments: { T: [VALID_ITEM] },
    ...overrides,
  };
}

const META: RegisterInstrumentMeta[] = [
  {
    code: 'T',
    name: 'Test instrument',
    respondent: 'Test respondent',
    feeds: 'Contextual only',
    scored: false,
    instrumentType: 'regulator',
  },
];

describe('validateRegisterPayload — structural validation', () => {
  it('accepts a well-formed payload and returns it unchanged', () => {
    const payload = validPayload();
    expect(validateRegisterPayload(payload)).toEqual(payload);
  });

  it('rejects a non-object payload', () => {
    expect(() => validateRegisterPayload(null)).toThrow(RegisterIngestionError);
    expect(() => validateRegisterPayload('nope')).toThrow(RegisterIngestionError);
  });

  it('rejects an empty schemaVersion', () => {
    expect(() => validateRegisterPayload(validPayload({ schemaVersion: '' }))).toThrow(
      /schemaVersion/,
    );
  });

  it('rejects an unrecognized source', () => {
    expect(() =>
      validateRegisterPayload({ ...validPayload(), source: 'made_up' as never }),
    ).toThrow(/"source"/);
  });

  it('rejects an empty sourceLabel', () => {
    expect(() => validateRegisterPayload(validPayload({ sourceLabel: '  ' }))).toThrow(
      /sourceLabel/,
    );
  });

  it('rejects a missing/non-object instruments map', () => {
    expect(() => validateRegisterPayload({ ...validPayload(), instruments: null })).toThrow(
      /instruments/,
    );
  });

  it('rejects an instrument whose items are not an array', () => {
    expect(() =>
      validateRegisterPayload({ ...validPayload(), instruments: { T: 'not-an-array' } }),
    ).toThrow(/must map to an array/);
  });

  it('rejects an item with an empty question_id', () => {
    expect(() =>
      validateRegisterPayload(
        validPayload({ instruments: { T: [{ ...VALID_ITEM, question_id: '' }] } }),
      ),
    ).toThrow(/question_id/);
  });

  it('rejects a duplicate question_id within one instrument', () => {
    expect(() =>
      validateRegisterPayload(
        validPayload({ instruments: { T: [VALID_ITEM, { ...VALID_ITEM }] } }),
      ),
    ).toThrow(/duplicate question_id/);
  });

  it('rejects an item with empty text', () => {
    expect(() =>
      validateRegisterPayload(validPayload({ instruments: { T: [{ ...VALID_ITEM, text: '' }] } })),
    ).toThrow(/"text"/);
  });

  it('rejects an item with an unrecognized kind', () => {
    expect(() =>
      validateRegisterPayload(
        validPayload({ instruments: { T: [{ ...VALID_ITEM, kind: 'essay' }] } }),
      ),
    ).toThrow(/"kind"/);
  });

  it('rejects an item with an unrecognized scope', () => {
    expect(() =>
      validateRegisterPayload(
        validPayload({ instruments: { T: [{ ...VALID_ITEM, scope: 'global' }] } }),
      ),
    ).toThrow(/"scope"/);
  });
});

describe('importSurveyRegister — the loader', () => {
  it('validates before writing: an invalid payload touches the database not at all', async () => {
    const before = await listInstrumentDefinitions(pool);
    await expect(
      importSurveyRegister(pool, { ...validPayload(), source: 'bogus' }, META),
    ).rejects.toThrow(RegisterIngestionError);
    const after = await listInstrumentDefinitions(pool);
    expect(after.length).toBe(before.length);
  });

  it('writes a valid payload through and tags provenance on the version row', async () => {
    const payload = validPayload({ sourceLabel: 'interim seed under test' });
    const ids = await importSurveyRegister(pool, payload, META);

    expect(Object.keys(ids)).toEqual(['T']);
    const items = await getInstrumentItems(pool, 'T');
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe('T-Q1');

    const version = await getLatestInstrumentVersion(pool, ids['T']!);
    expect(version?.schemaSnapshot).toMatchObject({
      registerPayloadSource: 'interim_seed',
      registerPayloadSchemaVersion: REGISTER_PAYLOAD_SCHEMA_VERSION,
      source: 'interim seed under test',
    });
  });

  it('distinguishes an approved_export payload in the same provenance field', async () => {
    const payload = validPayload({
      source: 'approved_export',
      sourceLabel: 'Controlled Register export v1',
    });
    const ids = await importSurveyRegister(pool, payload, META);
    const version = await getLatestInstrumentVersion(pool, ids['T']!);
    expect(version?.schemaSnapshot).toMatchObject({
      registerPayloadSource: 'approved_export',
      source: 'Controlled Register export v1',
    });
  });
});
