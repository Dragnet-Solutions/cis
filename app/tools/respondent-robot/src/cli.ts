/* eslint-disable no-console -- a command-line tool: the console is its interface */
import { Api, ApiError, sleep } from './api';
import type { Persona } from './answers';
import { isLocalUrl, parseConfig, USAGE, type Config } from './config';
import { inviteResolver } from './invites';
import {
  FatalError,
  StopRequested,
  firmSetupComplete,
  runInvestor,
  runRegulator,
  runSeat,
  setupFirm,
  type FlowContext,
} from './flows';
import { buildPlan, type FirmRef, type Plan } from './plan';
import { describePlan, describeRound, describeSummary, formatDuration } from './report';
import { Rng } from './rng';
import { roundTasks, selectRound, startOffsets, type Task } from './schedule';
import { incompatibility, loadState, newState, saveState, type RobotState } from './state';

const ts = (): string => new Date().toISOString().slice(11, 19);
const log = (line: string): void => console.log(`[${ts()}] ${line}`);

function planFor(config: Config, firms: FirmRef[]): Plan {
  return buildPlan(firms, {
    seed: config.seed,
    targets: config.targets,
    zipf: config.zipf,
    tailShare: config.tailShare,
    headMin: config.headMin,
    outreachShare: config.outreachShare,
    speederShare: config.speederShare,
    straightlinerShare: config.straightlinerShare,
  });
}

function thinkFn(config: Config): (persona: Persona, rng: Rng) => number {
  const [lo, hi] = config.thinkMs;
  return (persona, rng) => {
    if (hi <= 0) return 0;
    if (persona.kind === 'speeder') return Math.min(lo, 100 + rng.next() * 300);
    const ms = lo + rng.next() * (hi - lo);
    return persona.kind === 'straightliner' ? ms * 0.35 : ms;
  };
}

/** Rough time for one respondent to finish (for the estimate only). */
function journeyMs(config: Config): number {
  return ((config.thinkMs[0] + config.thinkMs[1]) / 2) * 30;
}

function estimate(config: Config, tasks: number): number {
  if (tasks === 0) return 0;
  const spread = config.durationMs ?? (tasks / config.ratePerMin) * 60_000;
  return spread + journeyMs(config);
}

async function main(): Promise<number> {
  const config = parseConfig(
    process.argv.slice(2).filter((a) => a !== '--'),
    process.env['INIT_CWD'] ?? process.cwd(),
  );
  if (config === 'help') {
    console.log(USAGE);
    return 0;
  }

  // ── Dry run: no API calls ────────────────────────────────────────────────
  if (config.dryRun) {
    const state = loadState(config.stateFile);
    const firms =
      state?.firms ??
      Array.from({ length: config.targets.firms }, (_, i) => ({
        id: `placeholder-${i + 1}`,
        displayName: `${config.firmPrefix} Firm ${String(i + 1).padStart(2, '0')}`,
      }));
    if (!state) {
      console.log(
        '(No state file yet: placeholder firm names are shown. The real run plans over the',
      );
      console.log(' edition’s participating firms whose names start with the firm prefix.)\n');
    }
    const plan = planFor(config, firms);
    console.log(describePlan(plan));
    const round = selectRound(plan, state, config.fraction, config.regulatorTokens);
    const tasks = roundTasks(round, config.seed).length;
    console.log(
      '\n' +
        describeRound({
          setupFirms: plan.firms.filter((f) => !firmSetupComplete(state?.firmState[f.id])).length,
          seats: round.seats.length,
          retail: round.retail.length,
          local: round.local.length,
          foreign: round.foreign.length,
          regulators: round.regulators.length,
          estimateMs: estimate(config, tasks),
        }),
    );
    if (config.regulatorTokens.length < config.targets.regulators) {
      console.log(
        `Note: ${config.regulatorTokens.length} regulator link(s) given; the target is ${config.targets.regulators}.`,
      );
    }
    return 0;
  }

  // ── Safety and the edition ────────────────────────────────────────────────
  const baseUrl = config.baseUrl!.replace(/\/+$/, '');
  const host = new URL(baseUrl).hostname;
  if (!isLocalUrl(baseUrl) && config.confirmHost !== host) {
    console.error(
      `Refusing to write to ${host} without confirmation. Re-run with --confirm-host ${host} ` +
        'once you are sure this is the test environment.',
    );
    return 2;
  }
  const api = new Api({
    baseUrl,
    maxRetries: config.maxRetries,
    backoffMs: 1000,
    maxBackoffMs: 60_000,
    timeoutMs: 30_000,
    onRetry: ({ path, attempt, waitMs, reason }) =>
      log(`retry ${attempt} in ${formatDuration(waitMs)}: ${path} — ${reason}`),
  });

  const context = await api.get<{
    editionId: string | null;
    editionLabel: string | null;
    editionStatus: string | null;
    collectionOpen: boolean;
  }>('/journeys/context');
  const editionId = config.editionId ?? context.editionId;
  if (!editionId) {
    console.error('The platform has no edition.');
    return 2;
  }
  if (editionId !== context.editionId || !context.collectionOpen) {
    console.error(
      `Edition ${editionId} is not the open, collecting edition (current: ${context.editionId} ` +
        `"${context.editionLabel}", status ${context.editionStatus}). Open it on the Edition screen first.`,
    );
    return 2;
  }
  log(`Edition ${context.editionLabel} (${editionId}) is collecting.`);

  // ── State and the firm list ───────────────────────────────────────────────
  let state: RobotState | null = loadState(config.stateFile);
  if (state) {
    const why = incompatibility(state, { baseUrl, editionId, seed: config.seed });
    if (why) {
      console.error(
        `The state file ${config.stateFile} cannot be used: ${why}. ` +
          'Use another --state-file (or delete it to start from scratch).',
      );
      return 2;
    }
  }
  const { firms: participating } = await api.get<{ firms: FirmRef[] }>(
    `/journeys/editions/${editionId}/participating-firms`,
  );
  const candidates = participating
    .filter((f) => f.displayName.startsWith(config.firmPrefix))
    .map((f) => ({ id: f.id, displayName: f.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
  if (!state) {
    if (candidates.length === 0) {
      console.error(
        `No participating firm's name starts with "${config.firmPrefix}". Import the [Test] firms ` +
          'on the Firm team screen ("Import the firm directory") for this edition first.',
      );
      return 2;
    }
    state = newState({
      baseUrl,
      editionId,
      seed: config.seed,
      firms: candidates.slice(0, config.targets.firms),
    });
    saveState(config.stateFile, state);
  }
  const st = state;
  if (st.firms.length < config.targets.firms) {
    log(
      `warning: planning over ${st.firms.length} firm(s); the target is ${config.targets.firms}.`,
    );
  }
  const active = new Set(participating.map((f) => f.id));
  const gone = st.firms.filter((f) => !active.has(f.id));
  if (gone.length > 0) {
    log(`warning: no longer participating: ${gone.map((f) => f.displayName).join(', ')}`);
  }
  const plan = planFor(config, st.firms);
  log(`State: ${config.stateFile}`);

  // ── Run control ───────────────────────────────────────────────────────────
  let stopping = false;
  let stopReason: string | null = null;
  let consecutiveFailures = 0;
  const stop = (reason: string): void => {
    if (!stopping) log(`Stopping: ${reason}`);
    stopping = true;
    stopReason ??= reason;
  };
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stop('interrupted (Ctrl-C again to quit at once; the state file is up to date)');
  });

  // Firm invitation links: CSV rows name their firm; a bare link is looked up
  // (public, rate-limited) to learn which firm it is for — only if needed.
  const invitesById = new Map<string, string>();
  const needSetup = plan.firms.some((f) => !firmSetupComplete(st.firmState[f.id]));
  if (needSetup && config.firmInvites.unnamed.length > 0) {
    log(`Looking up ${config.firmInvites.unnamed.length} firm invitation link(s)...`);
    for (const t of config.firmInvites.unnamed) {
      try {
        const { invitation } = await api.get<{
          invitation: { organizationId: string; firmName: string };
        }>(`/firm/invitations/${encodeURIComponent(t)}`);
        invitesById.set(invitation.organizationId, t);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status >= 500 || e.status === 0) throw e;
        log(`invitation link …${t.slice(-6)} cannot be used: ${e.message}`);
      }
    }
  }
  const inviteCount = config.firmInvites.byName.size + invitesById.size;
  if (needSetup) {
    log(
      inviteCount > 0
        ? `${inviteCount} firm invitation link(s) available for claiming.`
        : 'note: no firm invitation links given (--firm-invites); unclaimed firms can only be ' +
            'claimed if the API runs with FIRM_CLAIM_WITHOUT_INVITE=true ([Test] firms only).',
    );
  }

  const ctx: FlowContext = {
    api,
    plan,
    state: st,
    editionId,
    save: () => saveState(config.stateFile, st),
    thinkMs: thinkFn(config),
    isStopping: () => stopping,
    log,
    inviteTokenFor: inviteResolver(config.firmInvites, invitesById),
  };
  const runCounts: Record<string, { ok: number; failed: number }> = {};
  const count = (instrument: string, ok: boolean): void => {
    const c = (runCounts[instrument] ??= { ok: 0, failed: 0 });
    if (ok) c.ok++;
    else c.failed++;
  };
  const onFailure = (label: string, e: unknown): void => {
    if (e instanceof StopRequested) return;
    const msg = e instanceof Error ? e.message : String(e);
    log(`FAIL ${label}: ${msg}`);
    if (e instanceof FatalError) stop(msg);
    consecutiveFailures++;
    if (consecutiveFailures >= config.maxConsecutiveFailures) {
      stop(`${consecutiveFailures} failures in a row — check the API, then re-run to continue`);
    }
  };

  // ── Phase 1: the coordinators' part ───────────────────────────────────────
  const toSetUp = plan.firms.filter((f) => !firmSetupComplete(st.firmState[f.id]));
  if (toSetUp.length > 0) log(`Setting up ${toSetUp.length} firm(s) as their coordinators...`);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, config.concurrency) }, async () => {
      while (!stopping && next < toSetUp.length) {
        const firm = toSetUp[next++]!;
        try {
          const what = await setupFirm(ctx, firm);
          consecutiveFailures = 0;
          log(`firm ${firm.name}: ${what}`);
        } catch (e) {
          const fs = st.firmState[firm.id];
          if (fs) fs.lastError = e instanceof Error ? e.message : String(e);
          ctx.save();
          onFailure(`firm ${firm.name}`, e);
        }
      }
    }),
  );

  // ── Phase 2: the respondents ──────────────────────────────────────────────
  const round = selectRound(plan, st, config.fraction, config.regulatorTokens);
  const allTasks = config.setupOnly || stopping ? [] : roundTasks(round, config.seed);
  // A firm that is not set up (no invitation link, or claimed by someone else)
  // has no seat links: its seats wait for a later run instead of failing.
  const tasks = allTasks.filter(
    (t) => t.kind !== 'seat' || firmSetupComplete(st.firmState[t.seat.firmId]),
  );
  if (tasks.length < allTasks.length) {
    log(
      `${allTasks.length - tasks.length} seat respondent(s) skipped this run: their firm is not ` +
        'set up (see the firm lines above).',
    );
  }
  if (config.regulatorTokens.length === 0 && !config.setupOnly) {
    log(
      'note: no regulator links given (--regulator-links); the four regulator roles are skipped.',
    );
  }
  if (tasks.length > 0) {
    log(
      describeRound({
        setupFirms: 0,
        seats: round.seats.length,
        retail: round.retail.length,
        local: round.local.length,
        foreign: round.foreign.length,
        regulators: round.regulators.length,
        estimateMs: estimate(config, tasks.length),
      }),
    );
  }
  const offsets = startOffsets(tasks.length, config, new Rng(Date.now()));
  const t0 = Date.now();
  let active2 = 0;
  let done = 0;
  const inFlight = new Set<Promise<void>>();
  const progress = setInterval(() => {
    log(
      `progress: ${done}/${tasks.length} done, ${active2} answering, ${api.requests} requests, ${api.retries} retries`,
    );
  }, 60_000);

  const runTask = async (task: Task): Promise<void> => {
    const label =
      task.kind === 'seat'
        ? `${task.seat.seatCode} ${st.firmState[task.seat.firmId]?.name ?? task.seat.firmId}`
        : task.kind === 'investor'
          ? `${task.investor.instrument} ${task.key}`
          : `regulator ${task.key}`;
    const started = Date.now();
    const instrument =
      task.kind === 'seat'
        ? task.seat.seatCode
        : task.kind === 'investor'
          ? task.investor.instrument
          : 'I-*';
    try {
      const what =
        task.kind === 'seat'
          ? await runSeat(ctx, task.seat)
          : task.kind === 'investor'
            ? await runInvestor(ctx, task.investor)
            : await runRegulator(ctx, task.key, task.token);
      consecutiveFailures = 0;
      count(st.respondents[task.key]?.instrument || instrument, true);
      log(`ok   ${label}: ${what} (${formatDuration(Date.now() - started)})`);
    } catch (e) {
      if (!(e instanceof StopRequested)) {
        const r = st.respondents[task.key];
        st.respondents[task.key] = {
          attempts: 1,
          instrument,
          ...r,
          status: r?.status === 'submitted' ? 'submitted' : 'failed',
          lastError: e instanceof Error ? e.message : String(e),
        };
        ctx.save();
        count(instrument, false);
      }
      onFailure(label, e);
    } finally {
      done++;
    }
  };

  for (let i = 0; i < tasks.length && !stopping; i++) {
    const wait = t0 + (offsets[i] ?? 0) - Date.now();
    while (!stopping && (active2 >= config.concurrency || Date.now() < t0 + (offsets[i] ?? 0))) {
      await sleep(Math.min(250, Math.max(10, wait)));
      if (active2 >= config.concurrency && inFlight.size > 0) await Promise.race(inFlight);
    }
    if (stopping) break;
    active2++;
    const p = runTask(tasks[i]!).finally(() => {
      active2--;
      inFlight.delete(p);
    });
    inFlight.add(p);
  }
  await Promise.all(inFlight);
  clearInterval(progress);

  console.log('\n' + describeSummary(plan, st, runCounts));
  console.log(
    `\n${api.requests} requests, ${api.retries} retries, ${formatDuration(Date.now() - t0)} answering.`,
  );
  if (stopReason) {
    console.log(`Stopped early: ${stopReason}. Re-run the same command to continue.`);
    return 1;
  }
  const failed = Object.values(runCounts).reduce((s, c) => s + c.failed, 0);
  if (failed > 0)
    console.log(`${failed} respondent(s) failed; re-run the same command to retry them.`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ApiError) console.error(`API error: ${e.message}`);
    else console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
