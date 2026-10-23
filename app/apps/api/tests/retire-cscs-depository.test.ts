/**
 * D-16 — CSCS appears once on Market institutions: the depository role
 * (Family D) and its questionnaire I-DEP are retired by migration
 * 20261023200000_retire-cscs-depository.js.
 *
 * Starts from a database as dev has it before the migration: I-DEP and the
 * CSCS depository role active, I-DEP frozen into the open 2026 edition (the
 * snapshot is immutable and stays), an I-DEP response submitted, and the
 * three new institution questionnaires not yet frozen (D-01). Then:
 *   six institutions, CSCS once; the Renderer's 12 tabs; the D-01 pending
 *   list without I-DEP; I-DEP never frozen again and its link refused; the
 *   CSCS clearing row untouched; the report lists CSCS once. Plus
 *   idempotency and down/up.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, listInstitutions, updateEditionStatus } from '@cis/db';
import { loadRbacContext } from '@cis/auth';
import {
  seedReferenceData,
  requestFreeze,
  decideFreeze,
  saveContact,
  issueSurveyLink,
  getResumeByToken,
  submitJourney,
  buildIndustryReportContent,
} from '@cis/domain';
import { buildServer } from '../src/server';
import { answerAll } from '../../../packages/domain/tests/helpers/answers';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const MIGRATION = '../../../packages/db/migrations/20261023200000_retire-cscs-depository.js';
const PASSWORD = 'ChangeMe!2026';
const A = 'adaeze.okoro@cis.example';
const B = 'segun.oyegbesan@dragnet.example';
const NEW_CODES = ['I-FMDQ', 'I-LCFE', 'I-NASD'];
const RENDERER_TABS = [
  'I-CSCS',
  'I-FMDQ',
  'I-LCFE',
  'I-NASD',
  'I-NGX',
  'I-SEC',
  'S1',
  'S2',
  'S3',
  'S4',
  'S5a',
  'S5b',
];
const CSCS = 'Central Securities Clearing System';
const CONTACT = {
  who: 'Tolu Ade',
  role: 'Head, Operations',
  email: 't.ade@cscs.example',
  phone: '+234 803 555 0102',
  how: 'Introduced through CIS',
};

let app: FastifyInstance;
let editionId: string;
let cscsId: string;

type Migration = { up: (pgm: unknown) => void; down: (pgm: unknown) => void };
async function replay(direction: 'up' | 'down'): Promise<void> {
  const mod = (await import(MIGRATION)) as Migration & { default?: Migration };
  const m = mod.default ?? mod;
  const statements: string[] = [];
  m[direction]({ sql: (s: string) => statements.push(s) });
  for (const s of statements) await getTestPool().query(s);
}

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

/** Dev as it was before D-16. */
beforeEach(async () => {
  const pool = getTestPool();
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  cscsId = (await listInstitutions(pool)).find((i) => i.name === CSCS)!.id;

  // Un-retire: I-DEP and family D active, CSCS's depository engagement row present.
  await pool.query(`UPDATE instrument_definitions SET retired_at = NULL`);
  await pool.query(`UPDATE institution_roles SET retired_at = NULL`);
  await pool.query(
    `INSERT INTO institution_engagement (edition_id, institution_id, family_code)
     VALUES ($1, $2, 'D') ON CONFLICT DO NOTHING`,
    [editionId, cscsId],
  );

  // Frozen (I-DEP included) and open; then the three new questionnaires
  // registered after the freeze (D-01's pending set).
  const maker = await loadRbacContext(pool, seed.makerUserId);
  const checker = await loadRbacContext(pool, seed.checkerUserId);
  const f = await requestFreeze(pool, maker, editionId, 'Freeze for launch');
  await decideFreeze(pool, checker, editionId, f.id, { approved: true });
  await updateEditionStatus(pool, editionId, 'open');

  // CSCS answered both questionnaires.
  for (const family of ['C', 'D'] as const) {
    await saveContact(pool, editionId, cscsId, family, CONTACT);
    const view = await issueSurveyLink(pool, editionId, cscsId, family, {
      targetBy: '2026-11-15',
    });
    const resume = (await getResumeByToken(pool, view.surveyLink!.split('/').pop()!))!;
    await answerAll(pool, resume.respondent.id, resume.items, []);
    await submitJourney(pool, resume.respondent.id);
  }

  await pool.query(
    `DELETE FROM edition_instrument_snapshots s
      USING instrument_definition_versions v, instrument_definitions d
      WHERE s.instrument_definition_version_id = v.id
        AND v.instrument_definition_id = d.id AND d.code = ANY($1)`,
    [NEW_CODES],
  );
});

async function tokenFor(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  return res.json<{ token: string }>().token;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

interface Reg {
  name: string;
  familyCode: string;
  instrumentCode: string | null;
  state: string;
}
async function regulators(t: string): Promise<Reg[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/editions/${editionId}/regulators`,
    headers: auth(t),
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ regulators: Reg[] }>().regulators;
}
async function instruments(t: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/editions/${editionId}/instruments`,
    headers: auth(t),
  });
  return res.json<{
    frozen: boolean;
    pendingInstruments: string[];
    instruments: Array<{ code: string; frozen: boolean }>;
  }>();
}
const depSnapshots = async () =>
  (
    await getTestPool().query(
      `SELECT s.* FROM edition_instrument_snapshots s
         JOIN instrument_definition_versions v ON v.id = s.instrument_definition_version_id
         JOIN instrument_definitions d ON d.id = v.instrument_definition_id
        WHERE d.code = 'I-DEP'`,
    )
  ).rows;

describe('D-16 — before the migration (dev as it was)', () => {
  it('shows CSCS twice and I-DEP as a Renderer tab', async () => {
    const t = await tokenFor(A);
    const regs = await regulators(t);
    expect(regs).toHaveLength(7);
    expect(regs.filter((r) => r.name === CSCS)).toHaveLength(2);
    expect((await instruments(t)).instruments.map((i) => i.code)).toContain('I-DEP');
    expect(await depSnapshots()).toHaveLength(1);
  });
});

describe('D-16 — after the migration', () => {
  it('six institutions, CSCS once; 12 Renderer tabs; I-DEP never frozen, linked or reported', async () => {
    const pool = getTestPool();
    const snapshotBefore = await depSnapshots();
    await replay('up');
    const a = await tokenFor(A);
    const b = await tokenFor(B);

    // Market institutions: six, CSCS once — clearing, untouched (still confirmed, contact kept).
    const regs = await regulators(a);
    expect(regs.map((r) => r.name).sort()).toEqual(
      [
        CSCS,
        'FMDQ Group',
        'Lagos Commodities and Futures Exchange',
        'NASD OTC Securities Exchange',
        'Nigerian Exchange Limited',
        'Securities and Exchange Commission',
      ].sort(),
    );
    const cscs = regs.filter((r) => r.name === CSCS);
    expect(cscs).toHaveLength(1);
    expect(cscs[0]).toMatchObject({
      familyCode: 'C',
      instrumentCode: 'I-CSCS',
      state: 'confirmed',
    });

    // The retired row is kept (not deleted), just switched off.
    const dRow = await pool.query(
      `SELECT retired_at, contact_who FROM institution_engagement
        WHERE edition_id = $1 AND institution_id = $2 AND family_code = 'D'`,
      [editionId, cscsId],
    );
    expect(dRow.rows[0].retired_at).not.toBeNull();
    expect(dRow.rows[0].contact_who).toBe(CONTACT.who);

    // The retired role cannot be reached for a link.
    const link = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/regulators/${cscsId}/D/issue-link`,
      headers: auth(a),
      payload: { targetBy: '2026-11-30' },
    });
    expect(link.statusCode).toBeGreaterThanOrEqual(400);

    // Renderer: 12 tabs, no I-DEP; D-01 pending list without I-DEP.
    const inst = await instruments(a);
    expect(inst.instruments.map((i) => i.code).sort()).toEqual([...RENDERER_TABS].sort());
    expect(inst.frozen).toBe(true);
    expect(inst.pendingInstruments).toEqual(NEW_CODES);

    // The add-freeze covers the three; I-DEP is never part of it.
    const req = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/instruments/freeze/request`,
      headers: auth(a),
      payload: { reason: 'Add LCFE, NASD and FMDQ questionnaires' },
    });
    expect(req.statusCode).toBe(201);
    const actionId = req.json<{ criticalActionId: string }>().criticalActionId;
    const payload = await pool.query(`SELECT payload FROM critical_actions WHERE id = $1`, [
      actionId,
    ]);
    expect(payload.rows[0].payload.instrumentCodes).toEqual(NEW_CODES);
    const ok = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/instruments/freeze/${actionId}/decide`,
      headers: auth(b),
      payload: { approved: true },
    });
    expect(ok.statusCode).toBe(200);
    expect((await instruments(a)).pendingInstruments).toEqual([]);

    // Nothing left to freeze: a further request is refused, I-DEP included.
    const again = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/instruments/freeze/request`,
      headers: auth(a),
      payload: { reason: 'Try to freeze I-DEP again' },
    });
    expect(again.statusCode).toBe(409);

    // The immutable I-DEP snapshot is left exactly as it was.
    expect(await depSnapshots()).toEqual(snapshotBefore);

    // The report lists CSCS once; the I-DEP response is not read.
    const report = await buildIndustryReportContent(pool, editionId);
    const cscsReadings = report.institutional.filter((r) => r.role === CSCS);
    expect(cscsReadings).toHaveLength(1);
    expect(cscsReadings[0]!.familyCode).toBe('C');
    expect(JSON.stringify(report)).not.toMatch(/Depository/);

    // Mission board reads six institution rows.
    const board = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/mission-board`,
      headers: auth(a),
    });
    expect(board.statusCode).toBe(200);
    expect(JSON.stringify(board.json())).not.toMatch(/Depository/);
  });

  it('is idempotent: running it again changes nothing', async () => {
    await replay('up');
    const stamp = async () =>
      (
        await getTestPool().query(
          `SELECT 'i' AS t, code AS k, retired_at FROM instrument_definitions WHERE retired_at IS NOT NULL
           UNION ALL
           SELECT 'r', institution_id::text || family_code, retired_at FROM institution_roles WHERE retired_at IS NOT NULL
           UNION ALL
           SELECT 'e', id::text, retired_at FROM institution_engagement WHERE retired_at IS NOT NULL
           ORDER BY 1, 2`,
        )
      ).rows;
    const first = await stamp();
    expect(first.length).toBeGreaterThan(0);
    await replay('up');
    expect(await stamp()).toEqual(first);
  });

  it('down re-activates everything; up retires it again', async () => {
    const t = await tokenFor(A);
    await replay('up');
    expect(await regulators(t)).toHaveLength(6);
    try {
      await replay('down');
      const cols = await getTestPool().query(
        `SELECT 1 FROM information_schema.columns WHERE column_name = 'retired_at'
            AND table_name IN ('instrument_definitions', 'institution_roles', 'institution_engagement')`,
      );
      expect(cols.rowCount).toBe(0);
    } finally {
      await replay('up');
    }
    expect(await regulators(t)).toHaveLength(6);
    expect((await instruments(t)).instruments.map((i) => i.code)).not.toContain('I-DEP');
  });
});
