import { roundCount, type Plan, type PlannedInvestor, type PlannedSeat } from './plan';
import { Rng } from './rng';
import { isSubmitted, type RobotState } from './state';

/**
 * Which planned respondents this run answers, and when each one starts.
 *
 * `--fraction` is CUMULATIVE: a run covers the first `round(total × fraction)`
 * planned respondents of every kind, minus those the state file says are
 * already submitted. So `--fraction 0.3` then a plain run (fraction 1) does
 * 30% then the rest, and re-running either is harmless — a crashed or failed
 * respondent is simply picked up again.
 */

export type Task =
  | { kind: 'seat'; key: string; seat: PlannedSeat }
  | { kind: 'investor'; key: string; investor: PlannedInvestor }
  | { kind: 'regulator'; key: string; token: string };

export interface Round {
  seats: PlannedSeat[];
  retail: PlannedInvestor[];
  local: PlannedInvestor[];
  foreign: PlannedInvestor[];
  regulators: Array<{ key: string; token: string }>;
}

export function regulatorKey(token: string): string {
  return `regulator:${token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
}

export function selectRound(
  plan: Plan,
  state: RobotState | null,
  fraction: number,
  regulatorTokens: string[],
): Round {
  const todo = <T extends { key: string }>(list: T[]): T[] =>
    list
      .slice(0, roundCount(list.length, fraction))
      .filter((t) => !state || !isSubmitted(state, t.key));
  return {
    seats: todo(plan.seats),
    retail: todo(plan.retail),
    local: todo(plan.local),
    foreign: todo(plan.foreign),
    regulators: todo(regulatorTokens.map((token) => ({ key: regulatorKey(token), token }))),
  };
}

/** All of a round's tasks, interleaved in a seeded order. */
export function roundTasks(round: Round, seed: string): Task[] {
  const tasks: Task[] = [
    ...round.seats.map((seat): Task => ({ kind: 'seat', key: seat.key, seat })),
    ...[...round.retail, ...round.local, ...round.foreign].map((investor): Task => ({
      kind: 'investor',
      key: investor.key,
      investor,
    })),
    ...round.regulators.map((r): Task => ({ kind: 'regulator', key: r.key, token: r.token })),
  ];
  return Rng.derive(seed, 'order').shuffle(tasks.sort((a, b) => a.key.localeCompare(b.key)));
}

/**
 * Start offsets (ms from the run's start), evenly paced with ±50% jitter:
 * over `durationMs` when given, else at `ratePerMin`. Sorted ascending.
 */
export function startOffsets(
  count: number,
  pace: { durationMs: number | null; ratePerMin: number },
  rng: Rng,
): number[] {
  if (count === 0) return [];
  const gap = pace.durationMs !== null ? pace.durationMs / count : 60_000 / pace.ratePerMin;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.max(0, (i + 0.5) * gap + (rng.next() - 0.5) * gap));
  }
  return out.sort((a, b) => a - b);
}
