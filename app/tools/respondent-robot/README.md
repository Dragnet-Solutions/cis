# Respondent robot

Plays a full-size live study through the platform's **public HTTP API**: the same calls the survey
pages and the firm portal make. When it has finished, the study team can lock, score, approve and
generate the reports on the screens and see them filled with realistic data.

All the data it creates is test data. Firm names come from the team's `[Test]` CSV, every email it
makes up ends in `@test.example`, names are placeholders such as "Kemi Testwell", phone numbers
are `+234 000 555 ….`, and institution names start with `[Test]`.

## What it does

1. **Plays each firm's coordinator** (firm portal API). For each `[Test]` firm it:
   - claims the firm's space with `POST /firm/claim`, giving the firm's **invitation token**
     (from `--firm-invites`), privacy consent and a random six-digit PIN that it keeps in the
     state file. A firm with no invitation link is skipped with the reason on its line, and its
     seats wait for a later run;
   - signs in with `POST /portal/auth/login`;
   - assigns the three seats (S1 MD, S2 Compliance, S3 Operations) to three different fake
     people with `POST /portal/seats/:code/assign`;
   - reads the firm's three outreach links with `GET /portal/outreach`.

   It only assigns a seat that is **empty**. Reassigning a seat would invalidate its link and throw
   away any answers already started on it.

2. **Answers the seat surveys** S1, S2 and S3 through each seat's own link: `/firm-seats/:token/context`,
   then `start`, then the answers, then `submit` and `complete`.
3. **Answers as investors:**
   - 1,111 retail investors (S4), each rating 2–3 firms;
   - 25 local institutions (S5a);
   - 15 foreign institutions (S5b).

   About 80% arrive through a rated firm's outreach link (`?ref=`), which makes them attributable
   to that firm. For these the robot records the link's opens, starts and finishes events, as the
   page does. The rest come through the public entry ("I invest through a broker" → S4; "I
   represent an institution" → S5a or S5b).

   Every investor gives consent, an optional fake contact and their firm choices, then answers
   one question at a time and submits.

4. **Answers the four regulator roles** (I-SEC, I-NGX, I-CSCS, I-DEP), but only through the links
   that a person issued on the Regulators screen. You pass those links in.

The robot asks for the questions in the same way the survey page does, using
`GET /journeys/:id/resume`. It walks them with the shared `@cis/survey` sequencing: shared items
once, firm-specific items once per rated firm. It writes the exact answer shapes the controls
write:

| Question type | Answer shape                                                |
| ------------- | ----------------------------------------------------------- |
| Scale         | number                                                      |
| Single choice | option text                                                 |
| Yes/no        | `{v, detail}`, with `detail` only when the item asks for it |
| Select        | array, or `{picked, greatest}` for select-then-greatest     |
| Multi         | array                                                       |
| Rank          | exactly N options, in order                                 |
| Grid          | row → column → value                                        |
| Open text     | text                                                        |

It checks every answer with the server's own `isAnswered` rule before saving, so the server's
review-before-submit check accepts every submission. The register has no skip logic beyond the
yes/no detail and the optional S4-Q10, and the robot handles both.

### How the answers are shaped

- **Firm personality.** Each firm gets a seeded quality between 0 and 1. That quality tilts its own
  seat answers and its investors' ratings, so the reports show strong, average and weak firms.
  - Scales follow the scoring transforms. A high number is bad on S1-Q5 and S2-Q1.
  - Ordinal options are tilted by quality: frequency, risk, performance, capability, comparison
    and manual-process bands.
  - "Has a failure ever …?" yes/no questions get more "Yes" answers at weak firms.
- **Popularity.** Ratings follow a Zipf-like distribution over a seeded firm order. The least
  popular 10% of firms are a deliberate small-firm tail with only 3–8 retail investors each, so
  the reports' "fewer than ten → withheld" rule is visible. Every other firm gets at least 12.
- **Lazy respondents.** By default about 3% of investors are speeders and 3% are straight-liners.
  - Speeders answer at random, pause 0.1–0.4 s per question and submit in seconds.
  - Straight-liners pick the same position every time: the first option, the middle, or the last.
- **Pace.** Respondents start evenly over `--duration` (or at `--rate`), with ±50% jitter. Each
  normal respondent pauses `--think` (2–8 s by default) per question, and `--concurrency` caps how
  many answer at once.
- **Deterministic.** The same `--seed` and the same firm list give the same plan and the same
  answers.

## What it never does

- It never writes to the database and never imports `@cis/db` or `@cis/domain`. It only uses HTTP,
  plus the pure `@cis/survey` helpers.
- It never locks, scores, signs off, approves, generates, publishes or releases anything. It stops
  once the answers are in.
- It never adds firms to the directory. The team imports them with the CSV on the Firm team screen.
- It never issues regulator links.
- It never reassigns a seat that is already assigned, and never claims a firm that someone else has
  claimed. If that happens the firm is marked `other`, its seats are skipped, and its investors use
  the public entry instead.
- It refuses a non-local URL unless you repeat the host name with `--confirm-host`.

## Prerequisites

1. **The `[Test]` firms are imported and enrolled.** On the Firm team page, use "Import the firm
   directory" for this edition. That calls `POST /firms/import` with `editionId` and enrols the
   firms. The robot uses the edition's participating firms whose names start with `[Test]` (see
   `--firm-prefix`), sorted by name, up to `--firms`.
2. **The edition is collecting.** Its status must be `open`, meaning instruments are frozen and the
   opening date has passed, and it must be the **current** edition. The firm portal always works on
   the open edition, so the robot refuses any other.
3. **The `[Test]` firms are invited, and you have their links.** Claiming a firm's space needs
   its invitation link. On the Firm team page, under "Firm invitations this edition", open
   "Invite all unclaimed firms", put `[Test]` as the name prefix and an address pattern such as
   `coordinator+{slug}@test.example`, and invite. Then use "Download open links (CSV)" and pass
   the file with `--firm-invites`. The CSV is `firm,email,link,expires`; a file with one link
   (`…/firm?invite=<token>`) per line also works — the robot looks up which firm each is for.
   (For automated test runs only, an API started with `FIRM_CLAIM_WITHOUT_INVITE=true` lets
   `[Test]` firms be claimed without a link. It is off by default and never set on the cluster.)
4. **Regulator links are issued.** On the Regulators screen, a person adds each role's named contact
   and issues the link. Copy the four links into a text file, one per line. A full survey URL with
   `?resume=…`, the path `/journeys/resume/…` or a bare token all work, and labels such as
   `SEC A:` are ignored.
5. **The robot machine's IP is allow-listed on the API.** Set `RATE_LIMIT_ALLOWLIST` (see below).
6. **The workspace is built.** Run `pnpm install && pnpm build` in `app/`, because `@cis/survey` is
   used from its `dist/`.

### Rate limits and the allow-list

The API allows 1,000 requests per minute per IP. Sign-in is limited separately: 10 attempts per
15 minutes per IP on `/portal/auth/login` (`RATE_LIMIT_AUTH_MAX`).

- The robot signs in once per firm that still needs setting up, which is 80 sign-ins on the first
  run. Without the allow-list that alone takes about 2 hours: the robot waits out each 429, using
  `Retry-After`.
- At the recommended pace, answering stays around 250–300 requests per minute, under the global
  limit.
- Set `RATE_LIMIT_ALLOWLIST=<robot's public IP>` on the API for the duration of the run, then
  remove it.
- On the cluster the API sits behind two proxies (`TRUST_PROXY: "2"`). The IP to list is the
  robot machine's **public** IP as seen from outside (`curl -s https://ifconfig.me`).
- With several API replicas, every pod needs the variable.

## Commands

Run these from `app/`.

```bash
# See the plan: counts per firm, popularity, lazies, this round's work. No API calls.
pnpm robot --dry-run

# Round 1: about 30% of every target, spread over an hour
pnpm robot --base-url https://dev-cis.idhub.ng/api --confirm-host dev-cis.idhub.ng \
  --firm-invites ./firm-invitations.csv \
  --regulator-links ./regulator-links.txt --fraction 0.3 --duration 1h

# Round 2: the rest, spread over two hours (firms are claimed by now; the links are not needed)
pnpm robot --base-url https://dev-cis.idhub.ng/api --confirm-host dev-cis.idhub.ng \
  --regulator-links ./regulator-links.txt --duration 2h
```

How rounds work:

- `--fraction` is cumulative. Round 1 does the first 30% of the planned seats, retail,
  institutions and regulators. Round 2, at the default fraction of 1, does the remainder.
- Re-running a finished round does nothing.
- Re-running after a crash, Ctrl-C or failures continues where the run stopped. A respondent that
  was started is resumed from the server's own saved answers. One that was submitted is never
  answered again.
- `--setup-only` does just the coordinators' part: claims, seats and outreach links.

Other options are listed under `pnpm robot --help`. They cover targets (`--firms 80 --retail 1111
--local 25 --foreign 15`), shape (`--zipf`, `--tail-share`, `--outreach-share`, `--speeders`,
`--straightliners`), `--seed`, `--concurrency`, `--think` and `--rate`.

**Timing.** With the defaults (2–8 s per question), a retail investor rating three firms takes about
3 minutes and a seat survey about 1 minute. The full study is about 1,395 respondents and about
49,000 requests:

| Round                          | Respondents | Duration                | Concurrency | Requests      |
| ------------------------------ | ----------- | ----------------------- | ----------- | ------------- |
| `--fraction 0.3 --duration 1h` | about 420   | a little over 1 hour    | about 20    | about 250/min |
| The rest, `--duration 2h`      | about 975   | about 2 hours 5 minutes | about 25    | about 280/min |

## State file and starting from scratch

Progress is kept in `tools/respondent-robot/.state/robot-state.json` (git-ignored; change it with
`--state-file`). It records:

- the firm list the plan was built from;
- each coordinator's fake email and PIN, written before the claim is sent;
- seat and outreach link tokens;
- every respondent started, with its server id and whether it was submitted.

It is written atomically after every step.

A state file belongs to one API URL, one edition and one seed, and the robot refuses to mix them.
To start from scratch, either use a new `--state-file`, or delete the file **and** use a fresh
edition or database.

Starting from scratch has limits. The old claims and respondents stay on the server. The firms are
already claimed, so a new state file cannot sign in as their coordinators.

## Data-quality signals

The platform records **no** speeding or straight-lining signal:

- No duration, attention check or quality flag is computed anywhere.
- The scoring sign-off's "data-quality issues reviewed" item (`dataQualityFlagsReviewed`) is an
  attestation checkbox only.
- Respondents store only `created_at` and `submitted_at`. A reviewer could derive time-to-complete
  from these by hand: speeders show up as seconds, not minutes.
- Straight-liners are visible only in the answers themselves.

The lazy respondents are there so those patterns exist in the data. No screen flags them today.

## Tests

The pure logic is unit-tested without a database: answers per question kind, plan, rounds, state
and config parsing. The tests are in `tests/` and run in the workspace's `unit` project:

```bash
pnpm vitest run --project unit tools/respondent-robot
```
