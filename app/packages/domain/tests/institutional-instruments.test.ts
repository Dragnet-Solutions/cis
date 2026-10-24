/**
 * Institutional instruments I-LCFE, I-NASD and I-FMDQ (client decision, Sept
 * 2026): one registered institution, one bespoke questionnaire, one attributed
 * passage — and a Q0 scope gate that closes the survey on "Rare" /
 * "Effectively none" (real Postgres).
 *
 *  1. The additive migration registers the three on a database that already
 *     holds data, idempotently, without touching existing rows, and its frozen
 *     copy of the content equals the Survey Register.
 *  2. The Q0 route: the server accepts a submission that stops at a closing
 *     Q0, records it as responded, refuses later answers and ignores any left
 *     over from before the gate closed.
 *  3. Reporting: a gate-closed institution is a contributor with no attributed
 *     passage, and nothing describes it as having declined.
 *  4. Never scored: their answers change no index or score.
 *  5. The freeze refuses while any Register item carries the TODO marker.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { loadRbacContext } from '@cis/auth';
import {
  createOrganization,
  createRespondent,
  ensureSeats,
  getActiveMetricDefinitions,
  getInstrumentItems,
  getRegisterFixture,
  getResponsesForRespondent,
  insertResponse,
  isRevokedRecoveryToken,
  isEditionInstrumentSetFrozen,
  listInstrumentsNotFrozenForEdition,
  updateEditionStatus,
  getEditionStatus,
  listCalculatedResults,
  listInstitutions,
  listInstrumentDefinitions,
  REGISTER_TODO_MARKER,
  setSeatState,
} from '@cis/db';
import type { SurveyItem } from '@cis/survey';
import {
  seedReferenceData,
  listRegulators,
  saveContact,
  issueSurveyLink,
  getResumeByToken,
  getRegulator,
  saveDraftAnswer,
  submitJourney,
  ReviewGapError,
  ScopeClosedError,
  LinkInvalidatedError,
  buildIndustryReportContent,
  industryFacts,
  runCandidateScoring,
  runScoring,
  requestFreeze,
  decideFreeze,
  RegisterContentIncompleteError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';
import { answerAll } from './helpers/answers';

const MIGRATION = '../../db/migrations/20261022000000_institutional-instruments.js';
const NEW_CODES = ['I-LCFE', 'I-NASD', 'I-FMDQ'] as const;
const NEW_INSTITUTIONS = [
  'Lagos Commodities and Futures Exchange',
  'NASD OTC Securities Exchange',
  'FMDQ Group',
];

let pool: Pool;
let editionId: string;
let makerUserId: string;
let checkerUserId: string;
let ids: Record<string, string>;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  makerUserId = seed.makerUserId;
  checkerUserId = seed.checkerUserId;
  const institutions = await listInstitutions(pool);
  ids = Object.fromEntries(institutions.map((i) => [i.name, i.id]));
});
afterAll(async () => {
  await closeTestPool();
});

const CONTACT = {
  who: 'Amaka Eze',
  role: 'Head, Market Operations',
  email: 'a.eze@institution.example',
  phone: '+234 803 555 0101',
  how: 'Introduced through the CIS courtesy approach',
};

/** Issue a link to one of the three and return its respondent and items. */
async function openLink(name: string): Promise<{ respondentId: string; items: SurveyItem[] }> {
  await saveContact(pool, editionId, ids[name]!, 'B', CONTACT);
  const view = await issueSurveyLink(pool, editionId, ids[name]!, 'B', {
    targetBy: '2026-11-15',
  });
  const token = view.surveyLink!.split('/').pop()!;
  const resume = (await getResumeByToken(pool, token))!;
  return { respondentId: resume.respondent.id, items: resume.items };
}

const q0 = (items: SurveyItem[]) => items.find((i) => i.scopeGate)!;

async function answerQ0(respondentId: string, items: SurveyItem[], a: string): Promise<void> {
  await saveDraftAnswer(pool, respondentId, {
    questionId: q0(items).id,
    ratedFirmId: null,
    answer: { a },
  });
}

// ─── 1. The additive migration on a database that already holds data ─────────

/** Run the migration's `up` against the pool, statement by statement, the way
 *  node-pg-migrate would (it only queues `pgm.sql`). */
async function replayMigrationUp(): Promise<void> {
  const mod = (await import(MIGRATION)) as {
    up?: (pgm: unknown) => Promise<void>;
    default?: { up: (pgm: unknown) => Promise<void> };
  };
  const up = mod.up ?? mod.default!.up;
  const statements: string[] = [];
  await up({ sql: (s: string) => statements.push(s) });
  for (const s of statements) await pool.query(s);
}

/** Put the database back to how an existing (pre-decision) one looks: the
 *  three instruments absent, LCFE and NASD under review, no FMDQ Group. */
async function rewindToBeforeTheDecision(): Promise<void> {
  const names = NEW_INSTITUTIONS;
  await pool.query(
    `DELETE FROM institution_engagement e USING institutions i
      WHERE i.id = e.institution_id AND i.name = ANY($1)`,
    [names],
  );
  await pool.query(
    `DELETE FROM instrument_questions q USING instrument_definitions d
      WHERE d.id = q.instrument_definition_id AND d.code = ANY($1)`,
    [NEW_CODES],
  );
  await pool.query(
    `DELETE FROM instrument_definition_versions v USING instrument_definitions d
      WHERE d.id = v.instrument_definition_id AND d.code = ANY($1)`,
    [NEW_CODES],
  );
  await pool.query(`DELETE FROM instrument_definitions WHERE code = ANY($1)`, [NEW_CODES]);
  await pool.query(
    `DELETE FROM institution_roles r USING institutions i
      WHERE i.id = r.institution_id AND i.name = 'FMDQ Group'`,
  );
  await pool.query(`DELETE FROM institutions WHERE name = 'FMDQ Group'`);
  await pool.query(`UPDATE institution_roles SET instrument_code = NULL, mandate = NULL`);
  await pool.query(`UPDATE institutions SET is_active = FALSE WHERE name = ANY($1)`, [
    names.slice(0, 2),
  ]);
}

const snapshotOf = async (sql: string) => (await pool.query(sql)).rows;

describe('Migration: the three join an existing database, additively', () => {
  it('registers the institutions, instruments and engagement rows, touching nothing else', async () => {
    await rewindToBeforeTheDecision();
    expect((await listRegulators(pool, editionId)).map((r) => r.name)).not.toContain('FMDQ Group');
    // Existing work that must survive untouched.
    await saveContact(pool, editionId, ids['Securities and Exchange Commission']!, 'A', CONTACT);
    const before = {
      questions: await snapshotOf(`SELECT * FROM instrument_questions ORDER BY question_code`),
      engagement: await snapshotOf(`SELECT * FROM institution_engagement ORDER BY id`),
      definitions: await snapshotOf(`SELECT * FROM instrument_definitions ORDER BY code`),
    };

    await replayMigrationUp();

    // Market Institutions Register: the three, each pointing at its own instrument.
    const regs = await listRegulators(pool, editionId);
    for (const [name, code] of [
      ['Lagos Commodities and Futures Exchange', 'I-LCFE'],
      ['NASD OTC Securities Exchange', 'I-NASD'],
      ['FMDQ Group', 'I-FMDQ'],
    ] as const) {
      const r = regs.find((x) => x.name === name);
      expect(r, name).toBeDefined();
      expect(r!.instrumentCode).toBe(code);
      expect(r!.state).toBe('no_contact');
      expect(r!.familyCode).toBe('B');
    }
    expect(regs.map((r) => r.name)).not.toContain('FMDQ Securities Exchange Limited');
    expect(regs.find((r) => r.familyCode === 'A')!.instrumentCode).toBe('I-SEC');

    // Survey Register: exactly the Register's content, Q0 gate included.
    const fixture = getRegisterFixture();
    for (const code of NEW_CODES) {
      const live = await getInstrumentItems(pool, code);
      const raw = fixture.instruments[code]!;
      expect(live.map((i) => i.id)).toEqual(raw.map((r) => r.question_id));
      for (const [n, r] of raw.entries()) {
        const l = live[n]!;
        expect(l.text).toBe(r.text);
        expect(l.kind).toBe(r.kind);
        expect(l.scope).toBe(r.scope);
        expect(l.options ?? null).toEqual(r.options ?? null);
        expect(l.scored).toBe(false);
        expect(l.selectUpToN ?? null).toBe(r.select_up_to_n ?? null);
        expect(!!l.selectThenGreatest).toBe(r.select_then_greatest === 1);
        expect(!!l.hasOptionalComment).toBe(r.has_optional_comment === 1);
        expect(l.scopeGate ?? null).toEqual(
          r.scope_gate ? { closeOn: r.scope_gate.close_on, decision: r.scope_gate.decision } : null,
        );
      }
    }

    // Existing rows untouched: every pre-existing question, definition and
    // engagement row reads exactly as before.
    const after = {
      questions: await snapshotOf(
        `SELECT * FROM instrument_questions
          WHERE question_code NOT LIKE ALL (ARRAY['I-LCFE-%', 'I-NASD-%', 'I-FMDQ-%'])
          ORDER BY question_code`,
      ),
      engagement: (
        await pool.query(
          `SELECT * FROM institution_engagement WHERE id = ANY($1::uuid[]) ORDER BY id`,
          [before.engagement.map((r: { id: string }) => r.id)],
        )
      ).rows,
      definitions: await snapshotOf(
        `SELECT * FROM instrument_definitions
          WHERE code NOT IN ('I-LCFE', 'I-NASD', 'I-FMDQ') ORDER BY code`,
      ),
    };
    expect(after.questions).toEqual(before.questions);
    expect(after.engagement).toEqual(before.engagement);
    expect(after.definitions).toEqual(before.definitions);
    const sec = await getRegulator(
      pool,
      editionId,
      ids['Securities and Exchange Commission']!,
      'A',
    );
    expect(sec.contact?.who).toBe(CONTACT.who);
  });

  it('is idempotent: running it again changes nothing', async () => {
    await rewindToBeforeTheDecision();
    await replayMigrationUp();
    const count = async () =>
      (
        await pool.query<{ q: string; e: string; i: string; d: string }>(
          `SELECT (SELECT COUNT(*) FROM instrument_questions)::text AS q,
                  (SELECT COUNT(*) FROM institution_engagement)::text AS e,
                  (SELECT COUNT(*) FROM institutions)::text AS i,
                  (SELECT COUNT(*) FROM instrument_definitions)::text AS d`,
        )
      ).rows[0];
    const once = await count();
    await replayMigrationUp();
    expect(await count()).toEqual(once);
  });

  it('on a database seeded after the decision, it adds nothing (the seed already did)', async () => {
    const before = await snapshotOf(`SELECT id FROM instrument_questions ORDER BY id`);
    await replayMigrationUp();
    expect(await snapshotOf(`SELECT id FROM instrument_questions ORDER BY id`)).toEqual(before);
  });
});

// ─── 2. The Q0 scope gate ──────────────────────────────────────────────────────

describe('Q0 scope gate — a conditional route the server enforces', () => {
  it('every new instrument opens on Q0, gated on "Rare" / "Effectively none"', async () => {
    for (const code of NEW_CODES) {
      const items = await getInstrumentItems(pool, code);
      expect(items[0]!.id).toBe(`${code}-Q0`);
      expect(items[0]!.kind).toBe('single');
      expect(items[0]!.scopeGate).toMatchObject({ closeOn: ['Rare', 'Effectively none'] });
      expect(items[0]!.scopeGate!.decision).toMatch(/21 October 2026.*supersedes SV-010/s);
      expect(items.filter((i) => i.scopeGate)).toHaveLength(1);
    }
    // The approved three carry no Q0 and no gate (the document's one
    // deliberate structural difference).
    for (const code of ['I-SEC', 'I-NGX', 'I-CSCS', 'I-DEP']) {
      expect((await getInstrumentItems(pool, code)).some((i) => i.scopeGate)).toBe(false);
    }
  });

  it('a closing Q0 submits as complete, recorded as responded, with no later answers', async () => {
    const { respondentId, items } = await openLink('Lagos Commodities and Futures Exchange');
    await answerQ0(respondentId, items, 'Rare');

    // Nothing after the gate may be answered — and the institution is told
    // so without the question's ID (D-18), which stays on the error.
    const refused = await saveDraftAnswer(pool, respondentId, {
      questionId: 'I-LCFE-Q1',
      ratedFirmId: null,
      answer: { a: { picked: ['Manual processes'], greatest: 'Manual processes' } },
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ScopeClosedError);
    expect((refused as ScopeClosedError).message).toBe(
      'This question is not part of this survey: an earlier answer closed it.',
    );
    expect((refused as ScopeClosedError).questionId).toBe('I-LCFE-Q1');

    const written = await submitJourney(pool, respondentId);
    expect(written.map((r) => r.questionId)).toEqual(['I-LCFE-Q0']);

    const view = await getRegulator(
      pool,
      editionId,
      ids['Lagos Commodities and Futures Exchange']!,
      'B',
    );
    expect(view.state).toBe('confirmed');
    expect(view.closedByScopeGate).toBe(true);
    expect(view.history.map((h) => h.entry).join(' ')).not.toMatch(/declin/i);
    expect(view.history[0]!.entry).toMatch(/listed among the contributing institutions/);
  });

  it('answers left over from before the gate closed are ignored, never submitted', async () => {
    const { respondentId, items } = await openLink('FMDQ Group');
    await answerAll(pool, respondentId, items, []); // Q0 "Regular and substantial", Q1–Q5
    await answerQ0(respondentId, items, 'Effectively none'); // then closes it
    const written = await submitJourney(pool, respondentId);
    expect(written.map((r) => r.questionId)).toEqual(['I-FMDQ-Q0']);
    expect((await getResponsesForRespondent(pool, respondentId)).map((r) => r.questionId)).toEqual([
      'I-FMDQ-Q0',
    ]);
  });

  it('a non-closing Q0 keeps every item required', async () => {
    const { respondentId, items } = await openLink('NASD OTC Securities Exchange');
    await answerQ0(respondentId, items, 'Occasional');
    const err = await submitJourney(pool, respondentId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewGapError);
    expect((err as ReviewGapError).outstanding.map((o) => o.questionId)).toEqual([
      'I-NASD-Q1',
      'I-NASD-Q2',
      'I-NASD-Q3',
      'I-NASD-Q4',
      'I-NASD-Q5',
    ]);
    // ...and answering Q1 is allowed.
    await saveDraftAnswer(pool, respondentId, {
      questionId: 'I-NASD-Q2',
      ratedFirmId: null,
      answer: { a: 'Rarely' },
    });
  });
});

// ─── 3. Reporting ───────────────────────────────────────────────────────────

describe('Reporting — a gate-closed institution contributes, with no passage', () => {
  it('lists it among contributors, writes no reading for it, and never says "declined"', async () => {
    const lcfe = await openLink('Lagos Commodities and Futures Exchange');
    await answerQ0(lcfe.respondentId, lcfe.items, 'Rare');
    await submitJourney(pool, lcfe.respondentId);

    const nasd = await openLink('NASD OTC Securities Exchange');
    await answerAll(pool, nasd.respondentId, nasd.items, []);
    await submitJourney(pool, nasd.respondentId);

    const c = await buildIndustryReportContent(pool, editionId);
    // The attributed passages: NASD only, read from its own I-NASD items.
    expect(c.institutional.map((r) => r.code)).toEqual(['NASD']);
    const reading = c.institutional[0]!;
    expect(reading.frequency).toBe('Very frequently'); // I-NASD-Q2's first option
    expect(reading.capability).toBe('Very weak'); // I-NASD-Q5's first option
    expect(reading.vantage).toBe('OTC market view');
    // The methodology note's contributors: both.
    expect(c.institutionalContributors.map((i) => i.name).sort()).toEqual([
      'Lagos Commodities and Futures Exchange',
      'NASD OTC Securities Exchange',
    ]);
    expect(c.institutionalContributors.find((i) => i.name.startsWith('Lagos'))!.code).toBe('LCFE');
    expect(c.institutionalParticipation).toEqual({ invited: 2, contributed: 2 });

    // Nothing generated about the institutions says anyone declined, and no
    // narrative fact is ever produced about LCFE's reading.
    const facts = industryFacts(c);
    expect(JSON.stringify(c)).not.toMatch(/declin/i);
    expect(JSON.stringify(facts)).not.toMatch(/declin/i);
    expect(facts.some((f) => f.id.startsWith('INST.') && f.id.includes('LCFE'))).toBe(false);
    expect(facts.some((f) => f.id.startsWith('INST.') && f.id.includes('NASD'))).toBe(true);
  });
});

// ─── 4. Never scored, never in any index ─────────────────────────────────────

async function scoredFirm(slug: string): Promise<void> {
  const org = await createOrganization(pool, {
    slug,
    displayName: slug.toUpperCase(),
    orgType: 'firm',
  });
  await ensureSeats(pool, editionId, org.id);
  const answers: Record<'S1' | 'S2' | 'S3', Record<string, string>> = {
    S1: { 'S1-Q2': '8', 'S1-Q3': '8', 'S1-Q8': '9' },
    S2: { 'S2-Q1': '3' },
    S3: { 'S3-Q2': '0-10%' },
  };
  for (const seat of ['S1', 'S2', 'S3'] as const) {
    const resp = await createRespondent(pool, { editionId, instrumentCode: seat });
    await setSeatState(pool, {
      editionId,
      organizationId: org.id,
      seatCode: seat,
      state: 'complete',
      respondentId: resp.id,
    });
    for (const [q, a] of Object.entries(answers[seat])) {
      await insertResponse(pool, {
        editionId,
        respondentId: resp.id,
        questionId: q,
        scope: 'shared',
        ratedFirmId: null,
        answer: { a },
      });
    }
  }
}

const resultKey = (r: {
  subjectType: string;
  subjectId: string;
  metricCode: string;
  value: number | null;
  n: number | null;
  sufficiencyState: string;
}) => `${r.subjectType}|${r.subjectId}|${r.metricCode}|${r.value}|${r.n}|${r.sufficiencyState}`;

describe('Never scored, never in any index', () => {
  it('the Register marks every new instrument and item unscored, and no metric reads them', async () => {
    const defs = await listInstrumentDefinitions(pool);
    for (const code of NEW_CODES) {
      const def = defs.find((d) => d.code === code)!;
      expect(def.scored).toBe(false);
      expect(def.instrumentType).toBe('regulator');
      for (const item of await getInstrumentItems(pool, code)) expect(item.scored).toBe(false);
    }
    const metricQuestions = (await getActiveMetricDefinitions(pool)).flatMap(
      (m) => m.config.questionIds ?? [],
    );
    for (const id of metricQuestions) expect(id).not.toMatch(/^I-(LCFE|NASD|FMDQ)-/);
  });

  it('their answers change no score: candidate and provisional runs are identical with or without them', async () => {
    await scoredFirm('firm-a');
    await scoredFirm('firm-b');
    const candidateBefore = await runCandidateScoring(pool, editionId);
    const provisionalBefore = await runScoring(pool, { editionId, datasetHash: 'fixed' });
    const before = (await listCalculatedResults(pool, candidateBefore.run.id)).map(resultKey);
    expect(before.length).toBeGreaterThan(0);

    for (const name of NEW_INSTITUTIONS) {
      const { respondentId, items } = await openLink(name);
      await answerAll(pool, respondentId, items, []);
      await submitJourney(pool, respondentId);
    }

    const candidateAfter = await runCandidateScoring(pool, editionId);
    const provisionalAfter = await runScoring(pool, { editionId, datasetHash: 'fixed' });
    const after = (await listCalculatedResults(pool, candidateAfter.run.id)).map(resultKey);
    expect(after.sort()).toEqual(before.sort());
    expect(provisionalAfter.results.map(resultKey).sort()).toEqual(
      provisionalBefore.results.map(resultKey).sort(),
    );
  });
});

// ─── 5. Placeholder content can never be frozen ─────────────────────────────

describe('Instrument freeze refuses placeholder Register content', () => {
  it(`refuses a freeze request while any item carries ${REGISTER_TODO_MARKER}`, async () => {
    await pool.query(
      `UPDATE instrument_questions SET prompt_text = prompt_text || ' ' || $1
        WHERE question_code = 'I-LCFE-Q3'`,
      [REGISTER_TODO_MARKER],
    );
    const maker = await loadRbacContext(pool, makerUserId);
    const err = await requestFreeze(pool, maker, editionId, 'Freeze for launch').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RegisterContentIncompleteError);
    expect((err as Error).message).toContain('I-LCFE-Q3');
  });

  it('re-checks at approval, so content marked after the request is refused too', async () => {
    const maker = await loadRbacContext(pool, makerUserId);
    const checker = await loadRbacContext(pool, checkerUserId);
    const action = await requestFreeze(pool, maker, editionId, 'Freeze for launch');
    await pool.query(
      `UPDATE instrument_questions SET options = options || to_jsonb($1::text)
        WHERE question_code = 'I-FMDQ-Q1'`,
      [REGISTER_TODO_MARKER],
    );
    await expect(
      decideFreeze(pool, checker, editionId, action.id, { approved: true }),
    ).rejects.toBeInstanceOf(RegisterContentIncompleteError);
  });

  it('the loaded Register carries no marker, so the real content freezes', async () => {
    const maker = await loadRbacContext(pool, makerUserId);
    const checker = await loadRbacContext(pool, checkerUserId);
    const action = await requestFreeze(pool, maker, editionId, 'Freeze for launch');
    const { frozen } = await decideFreeze(pool, checker, editionId, action.id, { approved: true });
    expect(frozen).toBe(true);
  });
});

// ─── 6. UX-OPS-007 / UX-INS-003 alignment ─────────────────────────────────────

describe('UX-OPS-007 — register-driven institutions and questionnaire assignment', () => {
  it('every original role carries its explicit register assignment', async () => {
    const regs = await listRegulators(pool, editionId);
    const byKey = new Map(regs.map((r) => [`${r.name}/${r.familyCode}`, r.instrumentCode]));
    expect(byKey.get('Securities and Exchange Commission/A')).toBe('I-SEC');
    expect(byKey.get('Nigerian Exchange Limited/B')).toBe('I-NGX');
    expect(byKey.get('Central Securities Clearing System/C')).toBe('I-CSCS');
    // D-16: CSCS's depository role (I-DEP) is retired; CSCS answers once.
    expect(byKey.has('Central Securities Clearing System/D')).toBe(false);
    expect(regs.every((r) => r.questionnaireAssigned)).toBe(true);
  });

  it('an institution registered later appears on its own, without its questionnaire, and cannot be sent a link', async () => {
    await pool.query(`UPDATE institutions SET is_active = TRUE WHERE name = 'FMDQ Clear Limited'`);
    const regs = await listRegulators(pool, editionId);
    const clear = regs.find((r) => r.name === 'FMDQ Clear Limited');
    expect(clear).toBeDefined();
    expect(clear!.questionnaireAssigned).toBe(false);
    expect(clear!.instrumentCode).toBeNull();
    expect(clear!.nextStep).toBe('Assign bespoke questionnaire');

    await saveContact(pool, editionId, clear!.institutionId, 'C', CONTACT);
    await expect(
      issueSurveyLink(pool, editionId, clear!.institutionId, 'C', { targetBy: '2026-11-15' }),
    ).rejects.toMatchObject({ code: 'QUESTIONNAIRE_NOT_ASSIGNED' });
  });

  it('an assignment to an instrument not in the Survey Register is "not assigned" too', async () => {
    await pool.query(
      `UPDATE institution_roles r SET instrument_code = 'I-NOT-LOADED'
         FROM institutions i WHERE i.id = r.institution_id AND i.name = 'FMDQ Group'`,
    );
    const view = await getRegulator(pool, editionId, ids['FMDQ Group']!, 'B');
    expect(view.questionnaireAssigned).toBe(false);
    await saveContact(pool, editionId, ids['FMDQ Group']!, 'B', CONTACT);
    await expect(
      issueSurveyLink(pool, editionId, ids['FMDQ Group']!, 'B', { targetBy: '2026-11-15' }),
    ).rejects.toMatchObject({ code: 'QUESTIONNAIRE_NOT_ASSIGNED' });
  });

  it('cancel and start again invalidates the old link and discards its partial response', async () => {
    const { respondentId, items } = await openLink('NASD OTC Securities Exchange');
    await answerQ0(respondentId, items, 'Occasional');
    const oldToken = (
      await getRegulator(pool, editionId, ids['NASD OTC Securities Exchange']!, 'B')
    )
      .surveyLink!.split('/')
      .pop()!;

    await saveContact(pool, editionId, ids['NASD OTC Securities Exchange']!, 'B', {
      ...CONTACT,
      who: 'Tunde Bello',
    });

    expect(await getResumeByToken(pool, oldToken)).toBeNull();
    expect(await isRevokedRecoveryToken(pool, oldToken)).toBe(true);
    expect(
      (await pool.query(`SELECT 1 FROM respondent_drafts WHERE respondent_id = $1`, [respondentId]))
        .rowCount,
    ).toBe(0);
    await expect(
      saveDraftAnswer(pool, respondentId, {
        questionId: 'I-NASD-Q0',
        ratedFirmId: null,
        answer: { a: 'Occasional' },
      }),
    ).rejects.toBeInstanceOf(LinkInvalidatedError);
  });
});

describe('UX-INS-003 — the instrument resolves from the Register via the link', () => {
  it('the resume state names the register instrument and its type', async () => {
    await saveContact(pool, editionId, ids['FMDQ Group']!, 'B', CONTACT);
    const view = await issueSurveyLink(pool, editionId, ids['FMDQ Group']!, 'B', {
      targetBy: '2026-11-15',
    });
    const resume = (await getResumeByToken(pool, view.surveyLink!.split('/').pop()!))!;
    expect(resume.instrument).toEqual({
      code: 'I-FMDQ',
      name: 'FMDQ Group',
      instrumentType: 'regulator',
    });
    expect(resume.respondent.institutionName).toBe('FMDQ Group');
    expect(resume.items.map((i) => i.id)).toEqual([0, 1, 2, 3, 4, 5].map((n) => `I-FMDQ-Q${n}`));
  });
});

// ─── 7. Section 10: grouped by role, every label its own instrument's ────────

describe('Section 10 — six institutions, each card labelled by its own instrument', () => {
  it('builds every reading with its own instrument wording and role, and so do the facts', async () => {
    const regs = await listRegulators(pool, editionId);
    expect(regs).toHaveLength(6);
    for (const r of regs) {
      await saveContact(pool, editionId, r.institutionId, r.familyCode, CONTACT);
      const view = await issueSurveyLink(pool, editionId, r.institutionId, r.familyCode, {
        targetBy: '2026-11-15',
      });
      const resume = (await getResumeByToken(pool, view.surveyLink!.split('/').pop()!))!;
      await answerAll(pool, resume.respondent.id, resume.items, []);
      await submitJourney(pool, resume.respondent.id);
    }

    const c = await buildIndustryReportContent(pool, editionId);
    expect(c.institutional).toHaveLength(6);
    // CSCS once (D-16).
    expect(
      c.institutional.filter((r) => r.role === 'Central Securities Clearing System'),
    ).toHaveLength(1);
    const facts = industryFacts(c);
    const consequenceTexts = new Map<string, string>();
    for (const r of regs) {
      const items = await getInstrumentItems(pool, r.instrumentCode!);
      const text = (n: number) => items.find((i) => new RegExp(`(^|-)Q${n}$`).test(i.id))!.text;
      consequenceTexts.set(r.instrumentCode!, text(4));
      const reading = c.institutional.find(
        (x) => x.role === r.name && x.familyCode === r.familyCode,
      )!;
      expect(reading.labels).toEqual({
        issue: text(1),
        frequency: text(2),
        marks: text(3),
        consequence: text(4),
        capability: text(5),
      });
      const fact = facts.find((f) => f.id === `INST.${reading.key}`)!;
      expect(fact.statement).toContain(text(4));
    }
    // A label is never another instrument's.
    for (const reading of c.institutional) {
      const others = [...consequenceTexts.entries()].filter(
        ([, t]) => t !== reading.labels.consequence,
      );
      for (const [, t] of others) {
        expect(JSON.stringify(reading.labels)).not.toContain(t);
      }
    }
    for (const reading of c.institutional.filter((r) =>
      ['LCFE', 'NASD', 'FMDQ'].includes(r.code),
    )) {
      expect(JSON.stringify(reading.labels)).not.toMatch(/exchange efficiency/i);
    }
    // Grouped by role.
    expect([...new Set(c.institutional.map((r) => r.roleLabel))]).toEqual([
      'Regulatory / Supervisory',
      'Exchange / Market Operator',
      'Clearing / Settlement',
    ]);
    expect(
      c.institutional
        .filter((r) => r.roleLabel === 'Exchange / Market Operator')
        .map((r) => r.code),
    ).toEqual(expect.arrayContaining(['NGX', 'LCFE', 'NASD', 'FMDQ']));
  });
});

// ─── 8. An open, frozen edition gaining new instruments ─────────────────────

describe('Freezing new instruments into an open edition', () => {
  it('the edition keeps collecting; new links wait for a maker-checker add-freeze; old snapshots untouched', async () => {
    const maker = await loadRbacContext(pool, makerUserId);
    const checker = await loadRbacContext(pool, checkerUserId);

    // An existing database before the decision: ten instruments, frozen, open.
    await rewindToBeforeTheDecision();
    // Before the decision these roles answered their family's instrument;
    // give them that assignment so the pre-existing link can be issued.
    for (const [name, family, code] of [
      ['Securities and Exchange Commission', 'A', 'I-SEC'],
      ['Nigerian Exchange Limited', 'B', 'I-NGX'],
      ['Central Securities Clearing System', 'C', 'I-CSCS'],
      ['Central Securities Clearing System', 'D', 'I-DEP'],
    ]) {
      await pool.query(
        `UPDATE institution_roles r SET instrument_code = $3 FROM institutions i
          WHERE i.id = r.institution_id AND i.name = $1 AND r.family_code = $2`,
        [name, family, code],
      );
    }
    const first = await requestFreeze(pool, maker, editionId, 'Freeze for launch');
    await decideFreeze(pool, checker, editionId, first.id, { approved: true });
    await updateEditionStatus(pool, editionId, 'open');
    const sec = ids['Securities and Exchange Commission']!;
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    const secLink = (await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-11-15' }))
      .surveyLink!.split('/')
      .pop()!;
    const snapshotsBefore = (
      await pool.query(`SELECT * FROM edition_instrument_snapshots ORDER BY id`)
    ).rows;
    const versionsBefore = (
      await pool.query(`SELECT * FROM instrument_definition_versions WHERE is_frozen ORDER BY id`)
    ).rows;
    expect(snapshotsBefore).toHaveLength(9); // ten before the decision, less the retired I-DEP

    // The migration adds the three.
    await replayMigrationUp();

    expect(await isEditionInstrumentSetFrozen(pool, editionId)).toBe(true);
    expect(await getEditionStatus(pool, editionId)).toBe('open');
    expect(await listInstrumentsNotFrozenForEdition(pool, editionId)).toEqual([
      'I-FMDQ',
      'I-LCFE',
      'I-NASD',
    ]);

    // The old link still works, end to end.
    const secResume = (await getResumeByToken(pool, secLink))!;
    await answerAll(pool, secResume.respondent.id, secResume.items, []);
    expect((await submitJourney(pool, secResume.respondent.id)).length).toBe(5);

    // A new instrument's link is refused until it is frozen into the edition.
    const lcfe = ids['Lagos Commodities and Futures Exchange']!;
    await saveContact(pool, editionId, lcfe, 'B', CONTACT);
    const pendingView = await getRegulator(pool, editionId, lcfe, 'B');
    expect(pendingView.questionnaireFrozen).toBe(false);
    expect(pendingView.nextStep).toBe('Freeze the questionnaire for this edition');
    await expect(
      issueSurveyLink(pool, editionId, lcfe, 'B', { targetBy: '2026-11-15' }),
    ).rejects.toMatchObject({ code: 'QUESTIONNAIRE_NOT_FROZEN' });

    // The add-freeze: requested with a reason, approved by a second person.
    const add = await requestFreeze(pool, maker, editionId, 'Add LCFE, NASD and FMDQ');
    expect(add.payload).toMatchObject({
      mode: 'add',
      instrumentCodes: ['I-FMDQ', 'I-LCFE', 'I-NASD'],
    });
    await expect(
      decideFreeze(pool, maker, editionId, add.id, { approved: true }),
    ).rejects.toThrow(); // the requester cannot approve their own request
    const { frozen } = await decideFreeze(pool, checker, editionId, add.id, { approved: true });
    expect(frozen).toBe(true);
    expect(await listInstrumentsNotFrozenForEdition(pool, editionId)).toEqual([]);

    // Old snapshots and their versions are exactly as they were.
    const snapshotsAfter = (
      await pool.query(`SELECT * FROM edition_instrument_snapshots ORDER BY id`)
    ).rows;
    expect(snapshotsAfter).toHaveLength(12);
    for (const before of snapshotsBefore) {
      expect(snapshotsAfter).toContainEqual(before);
    }
    const versionsAfter = (
      await pool.query(`SELECT * FROM instrument_definition_versions WHERE id = ANY($1::uuid[])`, [
        versionsBefore.map((v: { id: string }) => v.id),
      ])
    ).rows;
    expect(versionsAfter.sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(versionsBefore);

    // Now the new link issues and works.
    const view = await issueSurveyLink(pool, editionId, lcfe, 'B', { targetBy: '2026-11-15' });
    const resume = (await getResumeByToken(pool, view.surveyLink!.split('/').pop()!))!;
    await answerQ0(resume.respondent.id, resume.items, 'Rare');
    expect((await submitJourney(pool, resume.respondent.id)).length).toBe(1);

    // Nothing left to freeze.
    await expect(requestFreeze(pool, maker, editionId, 'Freeze again please')).rejects.toThrow(
      /already frozen/,
    );
  });
});
