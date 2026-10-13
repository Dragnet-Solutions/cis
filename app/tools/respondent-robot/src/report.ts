import {
  plannedAttributed,
  plannedRetailRatings,
  SEGMENT_INSTRUMENT,
  type Plan,
  type PlannedInvestor,
} from './plan';
import { countsByInstrument, type RobotState } from './state';

/** Plain-text tables for the dry run and the final summary. */

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  if (str.length >= n) return str.slice(0, n);
  return right ? str.padStart(n) : str.padEnd(n);
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}h${String(m).padStart(2, '0')}m`
    : m > 0
      ? `${m}m${String(sec).padStart(2, '0')}s`
      : `${sec}s`;
}

function lazyCounts(list: PlannedInvestor[]): string {
  const sp = list.filter((r) => r.persona.kind === 'speeder').length;
  const st = list.filter((r) => r.persona.kind === 'straightliner').length;
  return `${sp} speeders, ${st} straight-liners`;
}

export function describePlan(plan: Plan): string {
  const lines: string[] = [];
  const ratings = plannedRetailRatings(plan);
  const attributed = plannedAttributed(plan);
  const instRatings = new Map<string, number>();
  for (const r of [...plan.local, ...plan.foreign]) {
    for (const id of r.ratedFirmIds) instRatings.set(id, (instRatings.get(id) ?? 0) + 1);
  }
  lines.push(`Plan (seed "${plan.seed}")`);
  lines.push(
    `  ${plan.firms.length} firms × 3 seats = ${plan.seats.length} seat surveys; ` +
      `${plan.retail.length} retail (S4), ${plan.local.length} local institutions (S5a), ` +
      `${plan.foreign.length} foreign institutions (S5b)`,
  );
  const all = [...plan.retail, ...plan.local, ...plan.foreign];
  const viaLink = all.filter((r) => r.viaFirmId).length;
  lines.push(
    `  ${viaLink} of ${all.length} investors arrive through a firm's outreach link, ` +
      `${all.length - viaLink} through the public entry`,
  );
  lines.push(
    `  Lazy: retail ${lazyCounts(plan.retail)}; institutions ${lazyCounts([...plan.local, ...plan.foreign])}`,
  );
  const under = plan.firms.filter((f) => (ratings.get(f.id) ?? 0) < 10);
  lines.push(
    `  ${under.length} firm(s) planned under 10 retail investors (withheld in the reports): ` +
      (under.map((f) => f.name).join(', ') || 'none'),
  );
  lines.push('');
  lines.push(
    `  ${pad('Pop', 4, true)}  ${pad('Firm', 34)} ${pad('Quality', 8)} ${pad('Tier', 8)} ` +
      `${pad('Retail', 6, true)} ${pad('Inst', 5, true)} ${pad('ViaLink', 7, true)}`,
  );
  for (const f of plan.firms.slice().sort((a, b) => a.popularityRank - b.popularityRank)) {
    lines.push(
      `  ${pad(f.popularityRank, 4, true)}  ${pad(f.name, 34)} ${pad(f.quality.toFixed(2), 8)} ` +
        `${pad(f.tier + (f.isTail ? '*' : ''), 8)} ${pad(ratings.get(f.id) ?? 0, 6, true)} ` +
        `${pad(instRatings.get(f.id) ?? 0, 5, true)} ${pad(attributed.get(f.id) ?? 0, 7, true)}`,
    );
  }
  lines.push('  (* = deliberate small-firm tail)');
  return lines.join('\n');
}

export function describeRound(work: {
  setupFirms: number;
  seats: number;
  retail: number;
  local: number;
  foreign: number;
  regulators: number;
  estimateMs: number;
}): string {
  return (
    `This run: set up ${work.setupFirms} firm(s); answer ${work.seats} seat surveys, ` +
    `${work.retail} retail, ${work.local} local, ${work.foreign} foreign, ${work.regulators} regulator(s). ` +
    `Estimated time: ${formatDuration(work.estimateMs)}`
  );
}

export function describeSummary(
  plan: Plan,
  state: RobotState,
  run: Record<string, { ok: number; failed: number }>,
): string {
  const lines: string[] = [];
  lines.push('Summary — this run');
  lines.push(`  ${pad('Instrument', 10)} ${pad('submitted', 9, true)} ${pad('failed', 7, true)}`);
  for (const [k, v] of Object.entries(run).sort()) {
    lines.push(`  ${pad(k, 10)} ${pad(v.ok, 9, true)} ${pad(v.failed, 7, true)}`);
  }
  lines.push('Summary — all runs (from the state file)');
  lines.push(
    `  ${pad('Instrument', 10)} ${pad('started', 8, true)} ${pad('submitted', 9, true)} ${pad('failed', 7, true)}`,
  );
  for (const [k, v] of Object.entries(countsByInstrument(state)).sort()) {
    lines.push(
      `  ${pad(k, 10)} ${pad(v.started, 8, true)} ${pad(v.submitted, 9, true)} ${pad(v.failed, 7, true)}`,
    );
  }

  const seatsDone = new Map<string, number>();
  const retailDone = new Map<string, number>();
  const attributed = new Map<string, number>();
  for (const [key, r] of Object.entries(state.respondents)) {
    if (r.status !== 'submitted') continue;
    if (key.startsWith('seat:')) {
      const firmId = key.split(':')[1] ?? '';
      seatsDone.set(firmId, (seatsDone.get(firmId) ?? 0) + 1);
    }
    if (r.instrument === SEGMENT_INSTRUMENT.retail) {
      for (const id of r.ratedFirmIds ?? []) retailDone.set(id, (retailDone.get(id) ?? 0) + 1);
    }
    if (r.viaFirmId) attributed.set(r.viaFirmId, (attributed.get(r.viaFirmId) ?? 0) + 1);
  }
  const planned = plannedRetailRatings(plan);
  lines.push('Per firm (all runs)');
  lines.push(
    `  ${pad('Firm', 34)} ${pad('Setup', 9)} ${pad('Seats', 5, true)} ${pad('Retail', 6, true)} ` +
      `${pad('/plan', 5, true)} ${pad('ViaLink', 7, true)}`,
  );
  for (const f of plan.firms) {
    const fs = state.firmState[f.id];
    const setup =
      fs?.claim === 'other' ? 'other' : fs?.claim === 'claimed' ? 'claimed' : fs ? 'partial' : '-';
    lines.push(
      `  ${pad(f.name, 34)} ${pad(setup, 9)} ${pad(`${seatsDone.get(f.id) ?? 0}/3`, 5, true)} ` +
        `${pad(retailDone.get(f.id) ?? 0, 6, true)} ${pad(planned.get(f.id) ?? 0, 5, true)} ` +
        `${pad(attributed.get(f.id) ?? 0, 7, true)}`,
    );
  }
  return lines.join('\n');
}
