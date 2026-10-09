/**
 * Production-shaped DEMO seed — builds a full, realistic edition on an EMPTY
 * database and drives it all the way to generated National and firm reports,
 * so the report screens can be seen with populated numbers (the QA report's
 * open item). Every firm, person and institution is synthetic and labelled
 * "[Demo]". Never point this at a real database.
 *
 *   DATABASE_URL=…/cis_demo DEMO_API_URL=http://localhost:3200 \
 *     pnpm --filter @cis/api seed:demo
 *
 * Data goes in through the domain services (the same code the API calls); every
 * two-person step — freeze, lock, scoring sign-off — goes through the running
 * API with two real operator sessions, exactly as the screens do it.
 *
 * Answers are random but REPRODUCIBLE (fixed seed) and biased per firm, so the
 * firms genuinely differ rather than all scoring the same.
 */
import {
  initializePool,
  getPool,
  closePool,
  getEditionByLabel,
  createOrganization,
  upsertEditionParticipation,
  getInstrumentItems,
} from '@cis/db';
import {
  seedReferenceData,
  startJourney,
  registerContact,
  setRatedFirms,
  saveDraftAnswer,
  submitJourney,
  getSeats,
  assignSeat,
  startSeatEntry,
  completeSeatEntry,
  saveContact,
  issueSurveyLink,
  getResumeByToken,
  listRegulators,
} from '@cis/domain';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from '@cis/auth';
import { buildJourneySequence, isAnswered, type SurveyItem } from '@cis/survey';

const API = process.env['DEMO_API_URL'] ?? 'http://localhost:3200';
// The seed signs in with a one-off random password, then hands the operators
// their real ones: copied, as hashes, from PASSWORD_SOURCE_DATABASE_URL (your
// dev database) when set. No plaintext password is read from anywhere.
const PASSWORD = randomBytes(24).toString('base64url');
const PASSWORD_SOURCE = process.env['PASSWORD_SOURCE_DATABASE_URL'];
const MAKER = 'adaeze.okoro@cis.example';
const CHECKER = 'segun.oyegbesan@dragnet.example';

// ─── Shape of the demo edition ─────────────────────────────────────────────────

/** quality 0..1 tilts every answer about the firm: higher reads better. */
const FIRMS = [
  { slug: 'demo-meridian', name: '[Demo] Meridian Securities', quality: 0.85, weight: 5 },
  { slug: 'demo-harbor', name: '[Demo] Harbor Capital', quality: 0.72, weight: 4 },
  { slug: 'demo-lagoon', name: '[Demo] Lagoon Stockbrokers', quality: 0.6, weight: 3 },
  { slug: 'demo-crest', name: '[Demo] Crest Investments', quality: 0.5, weight: 3 },
  { slug: 'demo-savanna', name: '[Demo] Savanna Asset Partners', quality: 0.38, weight: 2 },
  { slug: 'demo-delta', name: '[Demo] Delta Brokerage', quality: 0.25, weight: 2 },
  // Twelve firms in all: the firm-side shares (frictions, self-belief) are only
  // shown once at least ten firms have answered, as in production.
  { slug: 'demo-atlas', name: '[Demo] Atlas Stockbroking', quality: 0.66, weight: 3 },
  { slug: 'demo-northgate', name: '[Demo] Northgate Securities', quality: 0.55, weight: 2 },
  { slug: 'demo-palm', name: '[Demo] Palm Capital Markets', quality: 0.47, weight: 2 },
  { slug: 'demo-riverside', name: '[Demo] Riverside Brokers', quality: 0.41, weight: 2 },
  { slug: 'demo-keystone', name: '[Demo] Keystone Investments', quality: 0.33, weight: 1 },
  { slug: 'demo-coral', name: '[Demo] Coral Asset Management', quality: 0.3, weight: 1 },
];
const RETAIL_RESPONDENTS = 90;
const LOCAL_INSTITUTIONS = 10;
const FOREIGN_INSTITUTIONS = 6;
/** Demo-scale floors — the production ones (80 firms, 1,111 retail) are far larger. */
const FLOORS = { firm: 5, retail: 40, local_institution: 8, foreign_institution: 5 };

// ─── Reproducible randomness ───────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(2026);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const shuffle = <T>(xs: T[]): T[] =>
  xs
    .map((x) => ({ x, k: rand() }))
    .sort((p, q) => p.k - q.k)
    .map((p) => p.x);
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const COMMENTS = [
  'Statements arrive late at month end.',
  'The relationship manager is responsive.',
  'Online portal is hard to use on mobile.',
  'Settlement has improved this year.',
  'Corporate actions are communicated clearly.',
];

/** A random but valid answer, tilted by `quality` (0..1) where order means better. */
function answerFor(item: SurveyItem, quality: number): unknown {
  const opts = item.options ?? [];
  const lean = clamp01(quality + (rand() - 0.5) * 0.45);
  switch (item.kind) {
    case 'scale': {
      const min = item.scaleMin ?? 1;
      const max = item.scaleMax ?? 10;
      return { a: Math.round(min + (max - min) * lean) };
    }
    case 'single':
      return { a: pick(opts) };
    case 'multi':
      return { a: shuffle(opts).slice(0, 1 + Math.floor(rand() * Math.min(3, opts.length))) };
    case 'select': {
      const n = Math.max(1, Math.min(item.selectUpToN ?? 3, 1 + Math.floor(rand() * 3)));
      const picked = shuffle(opts).slice(0, n);
      return item.selectThenGreatest ? { a: { picked, greatest: picked[0] } } : { a: picked };
    }
    case 'rank':
      return { a: shuffle(opts).slice(0, item.rankExactlyN ?? 3) };
    case 'yesno': {
      const choices = opts.filter((o) => o !== item.conditionalDetailOn);
      return { a: { v: pick(choices.length ? choices : opts) } };
    }
    case 'grid': {
      const cols = item.gridDimensions ? Object.keys(item.gridDimensions) : ['Rating'];
      const grid: Record<string, Record<string, string>> = {};
      for (const row of item.gridRows ?? []) {
        grid[row] = {};
        for (const c of cols) {
          // Same column options the renderer offers: named dimensions, then the
          // item's own options (S4-Q8's better/same/worse), then a numeric scale.
          const dim = item.gridDimensions?.[c] ?? (item.gridScale ? undefined : opts);
          if (dim?.length) grid[row]![c] = pick(dim);
          else {
            const lo = item.gridScale?.min ?? 1;
            const hi = item.gridScale?.max ?? 5;
            grid[row]![c] = String(Math.round(lo + (hi - lo) * lean));
          }
        }
      }
      return { a: grid };
    }
    case 'open':
    default:
      return { a: pick(COMMENTS) };
  }
}

/** Answer every step of a journey; firm-specific steps lean on that firm's quality. */
async function answerJourney(
  respondentId: string,
  items: SurveyItem[],
  ratedFirmIds: string[],
  qualityOf: (firmId: string | null) => number,
): Promise<void> {
  const pool = getPool();
  const sequence = buildJourneySequence(items, ratedFirmIds);
  let step = 0;
  for (const s of sequence) {
    let answer = answerFor(s.item, qualityOf(s.ratedFirmId));
    // Belt and braces: never save something the review gate would reject.
    for (let tries = 0; !isAnswered(s.item, answer) && tries < 5; tries++) {
      answer = answerFor(s.item, qualityOf(s.ratedFirmId));
    }
    await saveDraftAnswer(pool, respondentId, {
      questionId: s.item.id,
      ratedFirmId: s.ratedFirmId,
      answer: answer as never,
      step: step++,
    });
  }
}

// ─── The running API, for every two-person step ────────────────────────────────

async function api<T>(path: string, method: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in failed for ${email}: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

const log = (msg: string): void => {
  // eslint-disable-next-line no-console -- seed script progress
  console.log(msg);
};

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  initializePool();
  const pool = getPool();

  if (await getEditionByLabel(pool, '2026')) {
    throw new Error('This database already has an edition — run the demo seed on an EMPTY one.');
  }
  const { editionId } = await seedReferenceData(pool);
  // A one-off password for the seed's own sign-ins; replaced at the end.
  const hash = await hashPassword(PASSWORD);
  await pool.query('UPDATE users SET password_hash = $1 WHERE email = ANY($2)', [
    hash,
    [MAKER, CHECKER],
  ]);
  log('Reference data seeded.');

  const maker = await signIn(MAKER);
  const checker = await signIn(CHECKER);

  // Setup: floors, launch today, two-person freeze → the edition opens itself.
  await api(`/editions/${editionId}/floors`, 'PATCH', maker, {
    floors: Object.entries(FLOORS).map(([category, floorValue]) => ({ category, floorValue })),
  });
  await api(`/editions/${editionId}/opening-date`, 'PATCH', maker, {
    openDate: new Date().toISOString().slice(0, 10),
  });
  await api(`/editions/${editionId}/instruments/freeze/request`, 'POST', maker, {
    reason: 'Demo edition: register verified',
  });
  const { pendingFreeze } = await api<{ pendingFreeze: { id: string } }>(
    `/editions/${editionId}/instruments`,
    'GET',
    maker,
  );
  await api(
    `/editions/${editionId}/instruments/freeze/${pendingFreeze.id}/decide`,
    'POST',
    checker,
    { approved: true },
  );
  // The edition opens on its own once frozen and the launch date has arrived —
  // evaluated when the edition is next read, as the screens do.
  const opened = await api<{ status: string }>(`/editions/${editionId}`, 'GET', maker);
  if (opened.status !== 'open') {
    throw new Error(`Expected the edition to open after the freeze, but it is ${opened.status}`);
  }
  log('Instruments frozen (two-person) — edition open.');

  // Firms, each completing all three seats.
  const firms: Array<(typeof FIRMS)[number] & { id: string }> = [];
  for (const f of FIRMS) {
    const org = await createOrganization(pool, {
      slug: f.slug,
      displayName: f.name,
      orgType: 'firm',
    });
    await upsertEditionParticipation(pool, { editionId, organizationId: org.id, status: 'active' });
    firms.push({ ...f, id: org.id });
  }
  const qualityById = new Map(firms.map((f) => [f.id, f.quality]));
  const qualityOf = (firmId: string | null): number =>
    firmId ? (qualityById.get(firmId) ?? 0.5) : 0.5;

  for (const firm of firms) {
    await getSeats(pool, editionId, firm.id);
    for (const seatCode of ['S1', 'S2', 'S3'] as const) {
      const seat = await assignSeat(pool, {
        editionId,
        organizationId: firm.id,
        seatCode,
        assignedName: `[Demo] ${seatCode} lead`,
        assignedEmail: `${seatCode.toLowerCase()}.${firm.slug}@demo.example`,
      });
      const { respondentId } = await startSeatEntry(pool, seat.linkToken);
      const items = await getInstrumentItems(pool, seatCode);
      await answerJourney(respondentId, items, [], () => firm.quality);
      await submitJourney(pool, respondentId);
      await completeSeatEntry(pool, seat.linkToken);
    }
  }
  log(`${firms.length} firms, all three seats complete.`);

  // Investors: retail rate 2–3 firms (busier firms more often); institutions likewise.
  const weighted = firms.flatMap((f) => Array.from({ length: f.weight }, () => f.id));
  const pickFirms = (n: number): string[] => {
    const chosen = new Set<string>();
    while (chosen.size < n) chosen.add(pick(weighted));
    return [...chosen];
  };
  const investor = async (
    instrumentCode: 'S4' | 'S5a' | 'S5b',
    institutionName: string | null,
  ): Promise<void> => {
    const rated = pickFirms(2 + Math.floor(rand() * 2));
    const r = await startJourney(pool, {
      editionId,
      instrumentCode,
      recruitingFirmId: rand() < 0.4 ? rated[0]! : null,
      institutionName,
    });
    await registerContact(pool, r.id, { consentAccepted: true, channel: 'none' });
    await setRatedFirms(pool, r.id, rated);
    await answerJourney(r.id, await getInstrumentItems(pool, instrumentCode), rated, qualityOf);
    await submitJourney(pool, r.id);
  };
  for (let i = 0; i < RETAIL_RESPONDENTS; i++) await investor('S4', null);
  for (let i = 1; i <= LOCAL_INSTITUTIONS; i++) {
    await investor('S5a', `[Demo] Local Institution ${i}`);
  }
  for (let i = 1; i <= FOREIGN_INSTITUTIONS; i++) {
    await investor('S5b', `[Demo] Foreign Fund ${i}`);
  }
  log(
    `${RETAIL_RESPONDENTS} retail, ${LOCAL_INSTITUTIONS} local and ${FOREIGN_INSTITUTIONS} foreign institutional investors submitted.`,
  );

  // Regulators: every role gets a contact, a link, and answers through it —
  // which confirms the role on its own.
  const roles = await listRegulators(pool, editionId);
  for (const role of roles) {
    await saveContact(pool, editionId, role.institutionId, role.familyCode, {
      who: `[Demo] Contact, ${role.name}`,
      role: 'Head of Market Operations',
      email: `contact.${role.familyCode.toLowerCase()}@demo.example`,
      phone: '+234 800 000 0000',
      how: 'Introduced by the CIS Registrar',
    });
    const issued = await issueSurveyLink(pool, editionId, role.institutionId, role.familyCode, {
      targetBy: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10),
    });
    const token = issued.surveyLink!.split('/').pop()!;
    const resume = await getResumeByToken(pool, token);
    const respondentId = resume!.respondent.id;
    await answerJourney(
      respondentId,
      await getInstrumentItems(pool, resume!.respondent.instrumentCode),
      [],
      () => 0.55,
    );
    await submitJourney(pool, respondentId);
  }
  log(`${roles.length} regulator roles answered through their links.`);

  // Close collection: two-person lock.
  const { criticalActionId } = await api<{ criticalActionId: string }>(
    `/editions/${editionId}/lock/request`,
    'POST',
    maker,
    { reason: 'Demo edition: collection complete' },
  );
  await api(`/editions/${editionId}/lock/${criticalActionId}/decide`, 'POST', checker, {
    approved: true,
  });
  log('Results locked (two-person).');

  // Score, then a two-person sign-off.
  const { run } = await api<{ run: { id: string } }>(
    `/editions/${editionId}/scoring-runs`,
    'POST',
    maker,
  );
  const { signoff } = await api<{ signoff: { id: string } }>(
    `/editions/${editionId}/scoring-runs/${run.id}/signoff/request`,
    'POST',
    checker,
    {
      checkedAccount: {
        populationCountsReviewed: true,
        floorStatusReviewed: true,
        dataQualityFlagsReviewed: true,
      },
    },
  );
  await api(`/scoring-signoffs/${signoff.id}/approve`, 'POST', maker, {});
  log('Scoring run signed off (two-person).');

  // National report from the live sufficiency and the confirmed regulators.
  const { sufficiency } = await api<{
    sufficiency: Record<string, { meets: boolean }>;
  }>(`/editions/${editionId}/sufficiency`, 'GET', maker);
  const { regulators } = await api<{
    regulators: Array<{ institutionId: string; status: string }>;
  }>(`/editions/${editionId}/regulators`, 'GET', maker);
  const engaged = new Set(
    regulators.filter((r) => r.status === 'confirmed').map((r) => r.institutionId),
  ).size;
  const segment = (k: string) => ({ meets: !!sufficiency[k]?.meets, thin: false });
  const { reportId } = await api<{ reportId: string }>(
    `/editions/${editionId}/national-report`,
    'POST',
    maker,
    {
      scoringRunId: run.id,
      context: {
        segments: {
          retail: segment('retail'),
          local_institution: segment('local_institution'),
          foreign_institution: segment('foreign_institution'),
        },
        regulatorsEngaged: Math.min(engaged, 3),
      },
    },
  );
  await api(`/national-reports/${reportId}/open`, 'POST', maker);
  log('National report generated and its draft opened.');

  // Firm reports: generated, each opened by the maker, and their release
  // requested. Releasing is two-person — the checker approves it once the
  // national report is approved.
  await api(`/editions/${editionId}/firm-reports/generate`, 'POST', maker, {
    scoringRunId: run.id,
  });
  const { reports } = await api<{ reports: Array<{ id: string }> }>(
    `/editions/${editionId}/firm-reports`,
    'GET',
    maker,
  );
  for (const r of reports) await api(`/firm-reports/${r.id}/open`, 'POST', maker);
  if (reports.length > 0) {
    await api(`/editions/${editionId}/firm-reports/release/request`, 'POST', maker, {
      reason: 'Demo: every firm report generated and read',
    });
  }
  log(`${reports.length} firm reports generated, opened and their release requested.`);

  await handOverPasswords(pool, hash);
  await closePool();
  log('Demo edition ready.');
}

/**
 * Give the operators their real passwords: the hashes from the dev database, so
 * one password works everywhere locally. Without a source database the one-off
 * seed password is replaced by an unusable one — set a real password with
 * `pnpm --filter @cis/api set-password <email>`.
 */
async function handOverPasswords(
  pool: ReturnType<typeof getPool>,
  seedHash: string,
): Promise<void> {
  if (PASSWORD_SOURCE) {
    const source = new Pool({ connectionString: PASSWORD_SOURCE });
    try {
      const { rows } = await source.query<{ email: string; password_hash: string }>(
        'SELECT email, password_hash FROM users WHERE email = ANY($1)',
        [[MAKER, CHECKER]],
      );
      for (const r of rows) {
        await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [
          r.password_hash,
          r.email,
        ]);
      }
      log(`Operator passwords copied from the source database (${rows.length}).`);
      if (rows.length === 2) return;
    } finally {
      await source.end();
    }
  }
  // Whoever still has the one-off seed password gets an unusable one instead.
  const unusable = await hashPassword(randomBytes(32).toString('base64url'));
  await pool.query('UPDATE users SET password_hash = $1 WHERE password_hash = $2', [
    unusable,
    seedHash,
  ]);
  log('Set the operators’ passwords with: pnpm --filter @cis/api set-password <email>');
}

main().catch(async (err) => {
  console.error('Demo seed failed:', err);
  await closePool().catch(() => undefined);
  process.exit(1);
});
