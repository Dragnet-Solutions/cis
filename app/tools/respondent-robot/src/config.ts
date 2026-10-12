import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PLAN_OPTIONS, DEFAULT_TARGETS, type Targets } from './plan';

/** Command-line configuration. Everything has a default except the API URL. */
export interface Config {
  baseUrl: string | null;
  editionId: string | null;
  seed: string;
  stateFile: string;
  fraction: number;
  /** Spread this run's respondents over this long (ms); null = use `ratePerMin`. */
  durationMs: number | null;
  ratePerMin: number;
  concurrency: number;
  /** Pause per question for a normal respondent, [min, max] ms. */
  thinkMs: [number, number];
  targets: Targets;
  firmPrefix: string;
  regulatorTokens: string[];
  dryRun: boolean;
  setupOnly: boolean;
  confirmHost: string | null;
  maxConsecutiveFailures: number;
  maxRetries: number;
  zipf: number;
  tailShare: number;
  headMin: number;
  outreachShare: number;
  speederShare: number;
  straightlinerShare: number;
}

export const DEFAULT_STATE_FILE = resolve(__dirname, '..', '.state', 'robot-state.json');

/** "2h", "90m", "45s", "1500ms", "1h30m" → milliseconds. */
export function parseDuration(input: string): number {
  const s = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = '';
  for (const m of s.matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[2];
    total += unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
    consumed += m[0];
  }
  if (!consumed || consumed !== s) throw new Error(`Not a duration: "${input}" (try 2h, 90m, 30s)`);
  return total;
}

/** "20/min", "20", "2/s", "600/h" → respondents per minute. */
export function parseRate(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(?:\/\s*(s|sec|m|min|h|hour))?$/.exec(input.trim().toLowerCase());
  if (!m) throw new Error(`Not a rate: "${input}" (try 20/min)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'min';
  const perMin = unit.startsWith('s') ? n * 60 : unit.startsWith('h') ? n / 60 : n;
  if (!(perMin > 0)) throw new Error('The rate must be above zero');
  return perMin;
}

/** "2s-8s", "500ms-3s", "0" → [min, max] ms. */
export function parseThink(input: string): [number, number] {
  const parts = input.split('-').map((p) => p.trim());
  const lo = parseDuration(parts[0] ?? '0');
  const hi = parts[1] !== undefined ? parseDuration(parts[1]) : lo;
  if (hi < lo) throw new Error(`--think: ${input} has its maximum below its minimum`);
  return [lo, hi];
}

/**
 * Regulator links as the Regulators screen shows them, one per line — a full
 * survey URL with `?resume=<token>`, the API path `/journeys/resume/<token>`,
 * or a bare token. Anything before the link on a line (a label such as
 * "I-SEC:") and lines starting with # are ignored.
 */
export function parseRegulatorLinks(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const q = /[?&]resume=([^&\s#]+)/.exec(line);
    const p = /\/journeys\/resume\/([^/?\s#]+)/.exec(line);
    const token = q?.[1] ?? p?.[1] ?? line.split(/[\s,;=]+/).pop() ?? '';
    const decoded = decodeURIComponent(token);
    if (decoded && !out.includes(decoded)) out.push(decoded);
  }
  return out;
}

function num(v: string | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
}

function share(v: string | undefined, name: string, fallback: number): number {
  const n = num(v, name, fallback);
  if (n > 1) throw new Error(`--${name} is a share between 0 and 1`);
  return n;
}

export const USAGE = `Respondent robot — plays a live study through the platform's public HTTP API.

Usage: pnpm robot -- --base-url <url> [options]

Where:
  --base-url <url>          API base, e.g. https://dev-cis.idhub.ng/api or http://localhost:3411
  --edition <uuid>          Edition to answer (default: the current one from /journeys/context;
                            it must be the open, collecting edition)
  --confirm-host <host>     Required for any non-local base URL: repeat its host name
  --regulator-links <file>  Regulator links issued on the Regulators screen, one per line
  --regulator-link <link>   ...or one link/token at a time (repeatable)

Rounds and state:
  --fraction <0..1>         Cumulative share of every target to have done after this run (default 1)
  --state-file <path>       Default: tools/respondent-robot/.state/robot-state.json
  --seed <text>             Plan seed (default cis-robot-1); fixed per state file
  --dry-run                 Print the plan and this round's work; no API calls
  --setup-only              Only claim firms / assign seats / read outreach links

Pace:
  --duration <d>            Spread this run's respondents over e.g. 2h, 90m (overrides --rate)
  --rate <n/min>            Start this many respondents per minute (default 10/min)
  --concurrency <n>         Most respondents answering at once (default 20)
  --think <min-max>         Pause per question for a normal respondent (default 2s-8s; 0 = none)

Targets (defaults are the study minimums):
  --firms 80 --retail 1111 --local 25 --foreign 15 --regulators 4
  --firm-prefix "[Test]"    Only firms whose name starts with this are used

Shape:
  --zipf 1.0 --tail-share 0.1 --head-min 12 --outreach-share 0.8
  --speeders 0.03 --straightliners 0.03

Safety:
  --max-consecutive-failures 8   Stop cleanly after this many respondents fail in a row
  --max-retries 6                Retries per request on 429 / 5xx / network errors
`;

export function parseConfig(argv: string[], cwd: string): Config | 'help' {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      'base-url': { type: 'string' },
      edition: { type: 'string' },
      seed: { type: 'string' },
      'state-file': { type: 'string' },
      fraction: { type: 'string' },
      duration: { type: 'string' },
      rate: { type: 'string' },
      concurrency: { type: 'string' },
      think: { type: 'string' },
      firms: { type: 'string' },
      retail: { type: 'string' },
      local: { type: 'string' },
      foreign: { type: 'string' },
      regulators: { type: 'string' },
      'firm-prefix': { type: 'string' },
      'regulator-links': { type: 'string' },
      'regulator-link': { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' },
      'setup-only': { type: 'boolean' },
      'confirm-host': { type: 'string' },
      'max-consecutive-failures': { type: 'string' },
      'max-retries': { type: 'string' },
      zipf: { type: 'string' },
      'tail-share': { type: 'string' },
      'head-min': { type: 'string' },
      'outreach-share': { type: 'string' },
      speeders: { type: 'string' },
      straightliners: { type: 'string' },
    },
  });
  if (values.help) return 'help';
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p));

  const regulatorTokens: string[] = [];
  if (values['regulator-links']) {
    regulatorTokens.push(
      ...parseRegulatorLinks(readFileSync(abs(values['regulator-links']), 'utf8')),
    );
  }
  for (const l of values['regulator-link'] ?? []) {
    for (const t of parseRegulatorLinks(l))
      if (!regulatorTokens.includes(t)) regulatorTokens.push(t);
  }

  const int = (v: string | undefined, name: string, fallback: number): number =>
    Math.floor(num(v, name, fallback));

  const config: Config = {
    baseUrl: values['base-url'] ?? null,
    editionId: values.edition ?? null,
    seed: values.seed ?? 'cis-robot-1',
    stateFile: values['state-file'] ? abs(values['state-file']) : DEFAULT_STATE_FILE,
    fraction: share(values.fraction, 'fraction', 1),
    durationMs: values.duration ? parseDuration(values.duration) : null,
    ratePerMin: values.rate ? parseRate(values.rate) : 10,
    concurrency: Math.max(1, int(values.concurrency, 'concurrency', 20)),
    thinkMs: parseThink(values.think ?? '2s-8s'),
    targets: {
      firms: int(values.firms, 'firms', DEFAULT_TARGETS.firms),
      retail: int(values.retail, 'retail', DEFAULT_TARGETS.retail),
      local: int(values.local, 'local', DEFAULT_TARGETS.local),
      foreign: int(values.foreign, 'foreign', DEFAULT_TARGETS.foreign),
      regulators: int(values.regulators, 'regulators', DEFAULT_TARGETS.regulators),
    },
    firmPrefix: values['firm-prefix'] ?? '[Test]',
    regulatorTokens,
    dryRun: !!values['dry-run'],
    setupOnly: !!values['setup-only'],
    confirmHost: values['confirm-host'] ?? null,
    maxConsecutiveFailures: Math.max(
      1,
      int(values['max-consecutive-failures'], 'max-consecutive-failures', 8),
    ),
    maxRetries: int(values['max-retries'], 'max-retries', 6),
    zipf: num(values.zipf, 'zipf', DEFAULT_PLAN_OPTIONS.zipf),
    tailShare: share(values['tail-share'], 'tail-share', DEFAULT_PLAN_OPTIONS.tailShare),
    headMin: int(values['head-min'], 'head-min', DEFAULT_PLAN_OPTIONS.headMin),
    outreachShare: share(
      values['outreach-share'],
      'outreach-share',
      DEFAULT_PLAN_OPTIONS.outreachShare,
    ),
    speederShare: share(values.speeders, 'speeders', DEFAULT_PLAN_OPTIONS.speederShare),
    straightlinerShare: share(
      values.straightliners,
      'straightliners',
      DEFAULT_PLAN_OPTIONS.straightlinerShare,
    ),
  };
  if (config.speederShare + config.straightlinerShare > 1) {
    throw new Error('--speeders plus --straightliners cannot exceed 1');
  }
  if (!config.dryRun && !config.baseUrl) throw new Error('--base-url is required');
  return config;
}

/** True for a base URL on this machine (no confirmation needed). */
export function isLocalUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  );
}
