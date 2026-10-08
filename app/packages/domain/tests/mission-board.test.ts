/**
 * Mission board — Phase 10 (UX-OPS-001) DoD §13, integration half.
 * Real Zeptomail delivered/bounced/opened/clicked data flowing through Phase 9's
 * SendingService abstraction into a batch report; and the live board evaluator
 * (institution engagement gate, edition phase).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  listTemplates,
  createBatch,
  insertRecipient,
  setInstitutionEngagement,
  listInstitutions,
} from '@cis/db';
import {
  seedReferenceData,
  ingestZeptomailEvent,
  getBatchReport,
  getMissionBoard,
  CONDITIONS,
  remediationForCohort,
  type RemediationCohort,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  editionId = (await seedReferenceData(pool)).editionId;
});
afterAll(async () => {
  await closeTestPool();
});

describe('Zeptomail delivery data flows through the Phase 9 abstraction', () => {
  it('delivered/bounced/opened/clicked events land on the matching recipients and drive the report', async () => {
    const template = (await listTemplates(pool, editionId)).find(
      (t) => t.name === 'First invitation',
    )!;
    const batch = await createBatch(pool, {
      editionId,
      templateId: template.id,
      audienceId: 'upload',
      audienceLabel: 'Uploaded list',
      sendingService: 'zeptomail',
    });
    await insertRecipient(pool, { batchId: batch.id, editionId, recipientEmail: 'a@x.example' });
    await insertRecipient(pool, { batchId: batch.id, editionId, recipientEmail: 'b@x.example' });

    // Zeptomail webhook events arrive asynchronously.
    expect(
      await ingestZeptomailEvent(pool, {
        batchId: batch.id,
        recipientEmail: 'a@x.example',
        event: 'email.delivered',
      }),
    ).toBe(true);
    expect(
      await ingestZeptomailEvent(pool, {
        batchId: batch.id,
        recipientEmail: 'a@x.example',
        event: 'email.opened',
      }),
    ).toBe(true);
    expect(
      await ingestZeptomailEvent(pool, {
        batchId: batch.id,
        recipientEmail: 'a@x.example',
        event: 'email.clicked',
      }),
    ).toBe(true);
    expect(
      await ingestZeptomailEvent(pool, {
        batchId: batch.id,
        recipientEmail: 'b@x.example',
        event: 'email.bounced',
      }),
    ).toBe(true);
    // An event for an unknown address does not match.
    expect(
      await ingestZeptomailEvent(pool, {
        batchId: batch.id,
        recipientEmail: 'ghost@x.example',
        event: 'email.delivered',
      }),
    ).toBe(false);

    const report = await getBatchReport(pool, batch.id);
    expect(report.delivered).toBe(1);
    expect(report.bounced).toBe(1);
    expect(report.opensReported).toBe(true);
    expect(report.opened).toBe(1);
    expect(report.clicksReported).toBe(true);
    expect(report.clicked).toBe(1);
  });
});

describe('Live board evaluation', () => {
  it('returns ranked cards and an edition phase without error', async () => {
    const asOf = new Date('2026-10-01T00:00:00Z');
    const board = await getMissionBoard(pool, editionId, asOf);
    expect(Array.isArray(board.cards)).toBe(true);
    expect(['before_launch', 'collection_open', 'closing_week', 'closed']).toContain(board.phase);
    // No condition-16 card while every regulator's target_by is unset (seeded NULL).
    expect(board.cards.some((c) => c.conditionId === 16)).toBe(false);
  });

  it('condition 16 fires once a regulator is late against a set target_by', async () => {
    const sec = (await listInstitutions(pool)).find(
      (i) => i.name === 'Securities and Exchange Commission',
    )!;
    await setInstitutionEngagement(pool, editionId, sec.id, 'A', {
      status: 'invited',
      targetBy: new Date('2026-09-01'),
    });
    const board = await getMissionBoard(pool, editionId, new Date('2026-10-01T00:00:00Z'));
    const c16 = board.cards.find((c) => c.conditionId === 16);
    expect(c16).toBeTruthy();
  });
});

/**
 * Post-demo findings, correction — no illustrative/internal-mechanism content
 * from OPS_MISSION_BOARD_BUILD_BRIEF.md survives into user-facing card or
 * action copy. This is the durable form of the check: not a fixed phrase
 * list (a phrase list only catches a word-for-word repeat of what was
 * already found), but a pattern for the CLASS of defect — a hardcoded
 * illustrative number standing in for a real computed value, or a
 * dash/paren-appended clause that explains why the SYSTEM behaves a certain
 * way (an implementation/audience-targeting/data-modeling reason) rather
 * than stating a fact about the real world the reader needs. The four
 * deterministic funnel-diagnosis labels in mission-forecast.ts
 * ('wrong person, dead address, or nobody acted', etc.) are deliberately NOT
 * covered by this pattern — they explain real-world firm state, which is
 * exactly what an operator needs, not how the software is built.
 */
describe('No brief-derived illustration or system-mechanism leakage in card/action copy', () => {
  const MECHANICS_JARGON = [
    /folded in/i,
    /not a separate card/i,
    /correct,\s*not a bug/i,
    /honest stub/i,
    /\bdedup(e|lication)?\b/i,
    /\bengine\s*[12]\b/i,
    /knowable without/i,
    /cannot be identified/i,
    /nowhere to (bulk-)?send/i,
    // A dash- or paren-appended clause explaining WHY the system took this
    // route, rather than stating the action/fact itself.
    /—\s*(the\s+)?(relevant\s+)?(system|audience|cohort|targeting)\b/i,
  ];

  function assertClean(label: string, text: string): void {
    for (const pattern of MECHANICS_JARGON) {
      expect(text, `${label} contains internal-mechanics jargon: "${text}"`).not.toMatch(pattern);
    }
  }

  it('no condition "what" (risk headline) leaks brief/engineering vocabulary', () => {
    for (const cond of CONDITIONS) {
      assertClean(`condition ${cond.id} "what"`, cond.what);
    }
  });

  it('no remediation-cohort action label leaks the reasoning behind the audience choice', () => {
    const cohorts: RemediationCohort[] = [
      'not_claimed',
      'claimed_no_assign',
      'assigned_outstanding',
      'started_not_submitted',
      'no_outreach',
      'no_link_activity',
      'institutional_all_firms',
      'bounced',
    ];
    for (const cohort of cohorts) {
      assertClean(`remediationForCohort('${cohort}')`, remediationForCohort(cohort).label);
    }
  });

  it('a live-evaluated board never reintroduces the exact previously-confirmed leaks', async () => {
    const board = await getMissionBoard(pool, editionId, new Date('2026-10-01T00:00:00Z'));
    for (const card of board.cards) {
      assertClean(`card ${card.conditionId} "whatIsAtRisk"`, card.whatIsAtRisk);
      for (const line of card.consequence) {
        assertClean(`card ${card.conditionId} consequence line`, line);
      }
      if (card.why) assertClean(`card ${card.conditionId} "why"`, card.why);
      if (card.recommendedAction) {
        assertClean(`card ${card.conditionId} action label`, card.recommendedAction.label);
      }
    }
  });
});
