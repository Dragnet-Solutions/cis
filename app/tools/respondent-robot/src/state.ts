import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FirmRef } from './plan';

/**
 * The robot's local memory between runs (a JSON file, git-ignored). It records
 * everything needed to continue without duplicating: the firm list the plan
 * was built from, each coordinator's generated email + PIN (written BEFORE the
 * claim is sent, so a crash mid-claim can still sign in), seat and outreach
 * link tokens, and every respondent the robot has started and whether it was
 * submitted. It is written atomically (temp file + rename) after every change.
 *
 * It holds test credentials for test firms only (PINs of coordinators the
 * robot itself created) — keep it out of git, which the folder's .gitignore does.
 */

export const STATE_VERSION = 1;

export type TaskStatus = 'started' | 'submitted' | 'failed';

export interface FirmState {
  name: string;
  coordinator: { name: string; email: string; phone: string; pin: string } | null;
  /** claimed = we hold the space; other = someone else claimed it first. */
  claim: 'pending' | 'claimed' | 'other' | null;
  seats: Partial<Record<'S1' | 'S2' | 'S3', { linkToken: string; assignedEmail: string | null }>>;
  outreach: Partial<Record<'individual' | 'local_institutional' | 'foreign_institutional', string>>;
  lastError?: string;
}

export interface RespondentState {
  status: TaskStatus;
  instrument: string;
  respondentId?: string;
  /** The firm whose outreach link it arrived through, if any. */
  viaFirmId?: string | null;
  ratedFirmIds?: string[];
  attempts: number;
  startedAt?: string;
  submittedAt?: string;
  lastError?: string;
}

export interface RobotState {
  version: number;
  baseUrl: string;
  editionId: string;
  seed: string;
  createdAt: string;
  updatedAt: string;
  /** The firm list the plan is built from — frozen at the first run. */
  firms: FirmRef[];
  firmState: Record<string, FirmState>;
  respondents: Record<string, RespondentState>;
}

export function newState(init: {
  baseUrl: string;
  editionId: string;
  seed: string;
  firms: FirmRef[];
}): RobotState {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    ...init,
    createdAt: now,
    updatedAt: now,
    firmState: {},
    respondents: {},
  };
}

export function loadState(path: string): RobotState | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RobotState;
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`State file ${path} has version ${parsed.version}, expected ${STATE_VERSION}`);
  }
  return parsed;
}

export function saveState(path: string, state: RobotState): void {
  state.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Refuse to mix runs: a state file belongs to one API, one edition and one
 * seed. Returns a reason, or null when compatible.
 */
export function incompatibility(
  state: RobotState,
  run: { baseUrl: string; editionId: string; seed: string },
): string | null {
  if (state.baseUrl !== run.baseUrl) return `it was made against ${state.baseUrl}`;
  if (state.editionId !== run.editionId) return `it is for edition ${state.editionId}`;
  if (state.seed !== run.seed) return `it was made with --seed ${state.seed}`;
  return null;
}

export function isSubmitted(state: RobotState, key: string): boolean {
  return state.respondents[key]?.status === 'submitted';
}

/** Per-instrument counts recorded in the state (cumulative across runs). */
export function countsByInstrument(
  state: RobotState,
): Record<string, { started: number; submitted: number; failed: number }> {
  const out: Record<string, { started: number; submitted: number; failed: number }> = {};
  for (const r of Object.values(state.respondents)) {
    const c = (out[r.instrument] ??= { started: 0, submitted: 0, failed: 0 });
    if (r.status === 'submitted') c.submitted++;
    else if (r.status === 'failed') c.failed++;
    else c.started++;
  }
  return out;
}
