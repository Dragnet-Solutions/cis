# CIS × Dragnet Survey Platform

Reusable multi-year survey, measurement and reporting platform. Year 1 (2026) is the first configured edition, not a one-off build.

## Architecture overview

| Package / App           | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `packages/shared-types` | TypeScript types shared across all packages                           |
| `packages/db`           | Schema migrations, typed query layer (raw parameterized SQL via `pg`) |
| `packages/audit`        | Shared audit-write service — the **only** gateway to `audit_log`      |
| `packages/auth`         | Password hashing (argon2id), RBAC, maker-checker primitives, JWT      |
| `packages/domain`       | Edition, instrument-freeze and response services (business rules)     |
| `packages/survey`       | Framework-agnostic shared-renderer logic (answer shape, validation)   |
| `apps/api`              | Fastify HTTP service wiring all packages together                     |
| `apps/admin`            | React admin SPA (edition, surveys, and the shared question renderer)  |

**Key invariants enforced from day one:**

- `edition_id` is first-class on every edition-bound row.
- No year-suffixed tables — a new edition is a new `editions` row, not a new schema.
- `organizations` (stable identity) and `edition_participation` (per-year state) are permanently separate.
- `audit_log` is append-only: UPDATE and DELETE are rejected by database triggers.
- Maker-checker: `approved_by ≠ requested_by` is enforced at both the service layer (meaningful error) and the database layer (CHECK constraint).
- Secrets are never committed or logged. Passwords use argon2id.

---

## Prerequisites

- **Node.js** ≥ 22
- **pnpm** ≥ 9
- **Docker + Docker Compose** (for local Postgres + Redis)

---

## Running locally

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum generate a real JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Start infrastructure

```bash
docker compose up -d
```

This starts:

- **postgres** on `localhost:5432` (dev database: `cis_dev`)
- **postgres_test** on `localhost:5433` (test database: `cis_test`)
- **redis** on `localhost:6379`

### 4. Run migrations

```bash
# Dev database
pnpm --filter @cis/db migrate:up

# Test database (for running tests locally)
DATABASE_URL=postgres://cis:cis_test_password@localhost:5433/cis_test \
  pnpm --filter @cis/db migrate:up
```

To roll back:

```bash
pnpm --filter @cis/db migrate:down
```

### 5. Start the API

```bash
pnpm --filter @cis/api dev
# or build + start:
pnpm build
pnpm --filter @cis/api start
```

The API listens on `http://localhost:3000` by default.

---

## Running tests

Tests run against a **real PostgreSQL** instance (not mocks). Ensure `postgres_test` is running before running tests.

```bash
# All tests
pnpm vitest run

# Specific package
pnpm vitest run --project db
pnpm vitest run --project audit
pnpm vitest run --project auth
```

The test database URL defaults to `postgres://cis:cis_test_password@localhost:5433/cis_test`. Override with `DATABASE_URL` env var.

---

## Linting and type checking

```bash
pnpm lint          # ESLint
pnpm lint:fix      # ESLint with auto-fix
pnpm format        # Prettier
pnpm typecheck     # tsc --noEmit across all packages
```

---

## Dependency audit

```bash
pnpm audit --audit-level=high
```

CI fails on high or critical vulnerabilities.

---

## Building

```bash
pnpm build         # Build all packages via Turborepo
```

---

## CI pipeline

Every push runs via GitHub Actions (`.github/workflows/ci.yml`):

1. **Lint** — ESLint
2. **Typecheck** — `tsc --noEmit`
3. **Build** — Turborepo build (also bundles the Survey Register seed into `@cis/db`'s `dist`)
4. **Migrate** — runs `node-pg-migrate up` against the CI Postgres service container
5. **Test** — Vitest integration tests against real Postgres
6. **Dependency audit** — `pnpm audit --audit-level=high`

---

## Architecture decisions

- **No ORM**: all queries are raw parameterized SQL through `pg`. Every query is visible and auditable.
- **Migrations**: `node-pg-migrate` with JavaScript migration files (transparent raw SQL inside).
- **Immutable audit log**: PostgreSQL triggers prevent UPDATE and DELETE on `audit_log`. TRUNCATE is allowed for test teardown only.
- **Maker-checker**: enforced at both service layer (`MakerCheckerViolationError`) and database layer (`CHECK (approved_by <> requested_by)`).
- **`edition_id` first-class**: every edition-scoped table carries `edition_id`. A 2027-DRAFT edition coexists with frozen 2026 data using the same schema — proven by the AT-01 dry-run test in `packages/db/tests/edition-lifecycle.test.ts`.

---

## Survey runtime & content authority (Phase 2)

The controlled Survey Register (nine instruments, 90 questions) is **data, not
code**. It is bundled as `packages/db/src/seed/survey-register-seed.json` and
loaded into `instrument_questions` by the parameterized `seedSurveyRegister`
loader — never hardcoded as a literal in application or renderer code.

- **SV-010 content gate** (`packages/db/tests/survey-register.test.ts`): walks
  every seeded question against the Register fixture and fails on any missing
  ID, text, kind, scope, option-set, or flag mismatch. This is the permanent
  regression gate for content updates — it fails on a missing ID rather than
  passing on a plausible paraphrase.
- **Shared renderer** (`packages/survey` logic + `apps/admin/src/renderer`
  controls): one control per Register `kind`, driven entirely by item data —
  ported faithfully from the approved `UX-X-RENDER-001` v2.0. Renderer logic is
  unit-tested in `packages/survey/tests`.
- **Response storage** (`packages/domain/response-service.ts`): raw, immutable
  answer rows (DB trigger blocks UPDATE/DELETE). Shared items store once;
  firm-specific items store once per **independently-selected** rated firm. The
  Rated Firm ID and the Source/Recruiting Firm ID are separate foreign keys — a
  respondent arriving via one firm never makes that firm a rated firm, and a
  shared answer is never copied across firms.
- **DRG-OPS non-disclosure**: all seven operational items are structurally
  excluded from the single `getPublicVisibleQuestions` accessor (proven by ID),
  while remaining part of the respondent runtime.

### ⚠️ Compliance follow-up before production edition freeze

`FUNCTIONAL_FREEZE_SURVEY_ESTATE.md` records that the three institutional Q5
items — **`I-SEC-Q5`, `I-NGX-Q5`, `I-CSCS-Q5`** — were still marked _pending
correction_ in the live controlled Register as of the 2026-08-20 freeze. The
seed file's Q5 wording may or may not be the corrected version. **Do not
finalize these three items into a production edition freeze without a compliance
sign-off against the current controlled Register.** (Flagged in-code at the top
of `packages/db/src/seed/register.ts`.)

## Respondent & firm journey surfaces (Phase 3)

Every survey-taking journey — the six survey instruments (S1–S5b) and the three
institutional/regulator instruments (I-SEC, I-NGX, I-CSCS) — runs through **one**
shell and **one** sequencing function; there is no per-instrument copy.

- **One sequencing function** (`packages/survey/src/sequence.ts`,
  `buildJourneySequence`): partitions items by `scope` and presents all `shared`
  items first (Register order), then, per **independently-selected** rated firm,
  the `firm_specific` items (Register order, repeated per firm). This scope
  grouping deliberately supersedes literal Register order. `firmContextAt`
  recovers which rated firm a given step belongs to, so resume restores the
  exact firm context mid-loop, not just a question number. Tested in
  `packages/survey/tests/sequence.test.ts`.
- **One journey shell** (`apps/admin/src/journey/JourneyShell.tsx`): one question
  at a time; a mandatory answer blocks progression (shared `outstanding()`); **no
  save control anywhere** — every change autosaves a mutable draft; submission is
  final only via an explicit review-before-submit step. Respondents run under
  `/survey` and never see the operator portal.
- **Draft → immutable freeze** (`packages/domain/journey-service.ts`,
  `submitJourney`): autosaved answers live in the mutable `respondent_drafts`
  table and are frozen into the immutable `responses` table in a single
  transaction on submit. Submission re-checks the consent gate and requires every
  required item to be answered server-side (`ReviewGapError` names the gaps).
- **PAT-011 consent (server-side)** (`registerContact`): consent gates the primary
  action and is required even when no contact detail is given — a contact field is
  only stored once consent is accepted. Consent copy and the recovery-link TTL are
  **governed content** (`governed_config`), not hardcoded; the provisional consent
  wording is owned by the DPO/legal (OPEN-003) and is swappable via
  `PUT /governed-config/:key`.
- **Attribution boundaries**: a referral (`createReferral`) and a colleague invite
  (`createColleagueInvite`) both start a fully independent journey with
  `recruiting_firm_id = NULL` — neither ever inherits the inviter's source firm; a
  colleague carries only the (never-published) institution name, with no stored
  link to the inviter.
- **Firm-facing visibility boundary** (structural, at the query layer):
  `getFirmRespondentStatuses` returns completion **status only** and never selects
  from `responses`; `outreach_links` carries **counters only** with no
  respondent/response key, so `getFirmOutreachSummary` cannot correlate a response
  to an outreach link. Proven in `packages/domain/tests/journey-service.test.ts`.
- **Firm coordinator team — UX-FRM-007** (`packages/domain/firm-team-service.ts`):
  ordinary account admin, **not** maker-checker. Lead handover is immediate and
  irreversible by the outgoing lead (only the current lead may hand over); the
  outgoing lead keeps ordinary access; a PIN change requires the current PIN;
  removal is immediate and a re-add issues a new access code. Tested in
  `packages/domain/tests/firm-team-service.test.ts`.

### ⚠️ Absorption-inventory gap (UX-RET-001 / UX-RET-003)

The retail entry (`UX-RET-001`) combines consent, contact, and recovery choice on
one surface. The **full absorption inventory** for what `UX-RET-001` and
`UX-RET-003` each subsume was **not supplied** as a settled artefact for this
phase, so the retail entry implements the PAT-011 consent/contact/firm-picker flow
and resume-by-link, but the complete field-by-field mapping of every element the
two surfaces are meant to absorb is **not yet reconciled**. Reconcile this
inventory against the controlled UX artefacts before the retail surface is treated
as feature-complete for a production edition.

The institutional **Q5 caveat above still applies** to the Phase 3 institutional
journeys: they bind their content to the Phase 2 Register by instrument code (the
question text is not transcribed in Phase 3 code), so the same
`I-SEC-Q5 / I-NGX-Q5 / I-CSCS-Q5` compliance sign-off is a prerequisite before any
institutional journey is finalized into a production edition freeze.

## Firm claim, portal, team & outreach (Phase 4)

The firm-facing surface (`UX-FRM-001`) — claim → set up access → assign three
internal respondents (S1/S2/S3) → invite three client segments → monitor link
volumes → receive results. It runs under `/firm`, strictly separate from the
operator portal and the respondent journeys.

- **One firm, one space** is a database invariant (`UNIQUE(organization_id)` on
  `firm_claims`). A second claimant is refused (`AlreadyClaimedError`) and
  redirected to sign in; the error carries **no identity** of the first claimant.
- **Firm identity is never inferred from an email domain.** Personal domains are
  accepted on the request-an-invitation path; a domain match is recorded only as
  an operational note (`domainNote`), never a gate. Affiliation is confirmed by
  CIS against the dealing member register (an operations action, `UX-OPS-002`).
- **Three consent behaviours, distinctly rendered**: privacy consent gates the
  primary action at both setup and request-an-invitation; follow-up consent is
  optional, gates nothing (kept freely given for `UX-ADM-007`), and is rendered
  with a dashed border + explicit "optional".
- **Four seat states** (`empty`/`invited`/`started`/`complete`). Replacing a
  _started_ seat states the cost first (the link stops, a part-finished answer is
  lost); replacing a _completed_ seat says the response is discarded. Computed
  from state **before** the change (`replacementCost`).
- **Sequence lock**: inviting clients stays disabled until all three seats are
  assigned, and the disabled control **states why** (`canInviteClients`).
- **Visibility boundary** (reused from Phase 3, not reimplemented): the seat
  accessor (`getSeatStatuses`) returns seat/role/**state only** and never selects
  answer content.
- **Measurement is volumes-only**: per-segment opens/starts/finishes. There is no
  respondent/response key on `outreach_links` (non-joinability), and deliberately
  **no invitation-count field anywhere** — the platform never receives a client
  list, so it cannot observe one.
- **Two struck claims never resurface**: no response-count threshold gates the
  combined report (the Reporting Specification guarantees it to every
  participating firm), and rating attribution is never gated on arrival-via-link
  (an investor picks firms independently — the link only pre-selects and measures).
  Both are proven by regression tests.

### The three confirmed v14.5 defects — all fixed with a test each

The artefact carried three still-open defects (verified in its markup). Each fix
is regression-tested in `apps/admin/src/firm/portalModel.test.ts`:

- **§2a `surveyNotBuilt` was dead code.** Now wired: clicking an individual seat
  row invokes `notBuiltForSeat`, showing the "owned by its own surface, not built
  here" feedback (naming `UX-FRM-004/005/006`).
- **§2b `pip3`/`pip4` could never activate.** The claim flow is genuinely two
  steps, so the indicator renders **two** pips (`PROGRESS_PIP_COUNT`); no view
  lights more than exist, and both positions are reachable.
- **§2c `access_model` was a phantom state.** It is absent from `PORTAL_VIEWS`
  (the 13 real views); the coordinator/respondent split is structural (seat status
  is state-only), not a screen.

### ⚠️ Design-registry inconsistency for design-ops to reconcile

`UX-FRM-002`, `UX-FRM-DIG-001`, and `UX-FRM-PREV-001` are **not** referenced in
this artefact's navigable markup, and both its own `destination_design_ids` and
`PACKAGE.md`'s "Children" line agree on exactly five destinations
(`UX-FRM-004/005/006/007` and `UX-FRM-RES-001`). If those three other surfaces
separately declare `UX-FRM-001` as their parent, that is a cross-registry
inconsistency recorded in two places that disagree — **not resolved by inventing
navigation here.** This build routes only to the five declared destinations
(the four Phase-3 surfaces link to the real thing; `UX-FRM-RES-001` is an honest
not-built stub). The registry owner should reconcile the parent/child mismatch.

> **Note on inputs:** the Phase 4 prompt referenced `PACKAGE.md` as a second
> authoritative attachment, but only the artefact was supplied. The build followed
> the prompt's extracted load-bearing rules and the artefact's embedded review
> contract; if `PACKAGE.md` carries anything beyond those, reconcile against it.

## Scoring, sufficiency, analytics & evidence (Phase 5, E07)

A versioned, reproducible calculation framework. It runs whatever methodology
gets approved — it never hardcodes a formula.

- **Event stream** (`funnel_event`): append-only. A `completed` event fires from
  the SAME transaction that finalizes a response (in both `submitJourney` and
  `submitResponses`), so the two can never drift. **One completed event per
  response** regardless of how many firms were rated (unique index enforced).
  `firm_id` is the register identifier, never a name; institutions are counted by
  distinct `institution_ref` (an opaque token), never by response count.
- **Firm eligibility** (`isFirmEligible` / `eligibleFirmIds`): a firm is eligible
  for scoring with at least one of S1/S2/S3 complete. Eligibility runs and is
  persisted as its **own step** (`runEligibility`, `run_type='eligibility'`)
  before any scoring pass touches response data. Segment floors come from Phase
  1's `edition_sample_floors` (the single source of truth), not duplicated.
- **Versioned calculation core**: `metric_definitions` (configuration — which
  question IDs feed which index, and the aggregation rule — as data, versioned),
  `calculation_runs` (immutable), `calculated_results` (immutable; a correction is
  a new run). Two methodology versions can run against the same frozen dataset
  (same `dataset_hash`) and **both result sets are retained** — Architecture Test
  AT-02, implemented as a real test.
- **Sufficiency** is a closed set (`REPORTABLE`/`DIRECTIONAL`/`BANDED`/
  `SUPPRESSED`), computed before any evidence is built. A SUPPRESSED result never
  stores its underlying value; a BANDED result carries a band, never a point
  value (DB CHECK + write-path validation).
- **Evidence packs** are the reporting-facing boundary. Report sections are a
  closed set (`PUB_01`–`PUB_10`, `FRM_01`–`FRM_04`). Construction (`buildEvidencePack`)
  **rejects**: any DRG-OPS source id (reusing the Phase 2 `is_drg_ops` flag), a
  BANDED fact with a point value, a suppressed guaranteed firm section
  (`FRM_01/02/03` — Acceptance Test 8), institutional data used as an index input
  (and any institutional cut in a firm report), and any cross-firm leak in a
  firm-scoped pack. Every fact carries a `source` chain back to
  `calculated_results → calculation_run → the eligible raw responses`.
- **Firm attribution**: a firm's scored results come from every response that
  rated it (`rated_firm_id`), regardless of arrival route — never from
  `firm_id`-tagged outreach. `firm_id`-tagged completions feed only the
  participating-firm report-dependency check (`countAttributable`), never scoring.
- **Report-dependency configuration** (`report_dependency`): study-team-editable
  runtime config, evaluated against live per-segment sufficiency
  (`evaluateReportDependencies`) so a section's viability is known during
  collection, not at publication.

### ⚠️ Provisional scoring methodology

The OMI/DMI/IEI/ICI/SEI weighting **does not exist yet as a controlled artefact**
(`UX-ADM-004`: "the weighting is Dragnet's methodology, pending validation"). The
seeded `metric_definitions` are a clearly-flagged **provisional placeholder**
(equal weighting, no settled question mapping; `is_provisional = TRUE`, and a
`PLACEHOLDER` note in each config). They exist so the framework runs end-to-end
and are **trivially replaceable without a code deploy** — a new
`metric_definitions` version — once Dragnet's methodology is validated. No
statistically-plausible formula has been invented or hardcoded (PRD §9). The
local-vs-foreign institution split is likewise a governed classification not yet
settled; institutional completions default to `local_institution` in the funnel
mapping, documented in `funnel-service.ts`, pending that classification.

> **Note on inputs:** the Phase 5 prompt referenced `EVIDENCE_PACK_CONTRACT.md`
> and `OPS_RESPONSES_CALCULATION_BRIEF.md` as controlled sources to read in full,
> but neither was attached — only the phase prompt. The build followed the
> prompt's extracted schemas and its DoD (written as literal acceptance tests);
> if the controlled documents carry anything beyond those, reconcile against them.

## AI reporting, review & publication (Phase 6, E08)

Two surfaces with **deliberately different** guarantee semantics — never one
shared pipeline, because conflating them is how the guarantee is lost.

**National report (`UX-ADM-005`, `national-report-service`):**

- The ten sections are a **closed set** of `EVIDENCE_PACK_CONTRACT` IDs
  (`NATIONAL_SECTIONS`); the generator iterates the catalogue and cannot produce
  an eleventh (a DB CHECK is the backstop).
- Each section is gated by **its own rule**: §2 (segment cuts) is _caveated_ when
  thin; §7 (local vs. foreign) is _suppressed_ outright below floor; §10
  (Institutional Perspectives) requires **all three** regulators — two is not the
  module. Suppressed sections are **named**, never just counted.
- The draft is reviewed **sentence by sentence**. A sentence with no fact IDs is
  unsupported _by construction_, not by adversary opinion. Three dispositions
  (`ACCEPT_AND_EDIT` / `REJECT_WITH_REASON` / `SUPPRESS_CLAIM`); a rejection
  requires a reason, enforced at the data layer (a CHECK constraint).
- **Adversary health** is measured against a seeded set of known-unsupported
  claims (`runAdversaryHealth`) and **gates approval** — a clean draft and a
  broken checker look identical.
- Approval requires **all four** preconditions simultaneously: a signed scoring
  run, the draft opened, every finding dispositioned, and a healthy checker — and
  the approver must differ from the requester. "Opened" is a real gate: a
  consequential approval puts the artefact in front of the reviewer.

**Firm reports (`UX-ADM-006`, `firm-report-service`):**

- `FRM_01/02/03` are **guaranteed** to every participating firm regardless of
  volume — never suppressible (the evidence-pack builder throws on a suppressed
  guaranteed section). Only the retail cut `FRM_04` is gated, with **three
  states**: below 10 nothing, 10–29 `directional`, 30+ `unlocked`.
- Generation and reconciliation are their own tracked phase before release.
- **Release is atomic per report.** A failed/unresolved report is **held, not
  excluded** (with a reason, recorded in the permanent per-report release
  history); every other approved report still releases.
- Release is **blocked until the national report is approved**.
- **Nothing released is ever recalled or edited** — a released `firm_reports` row
  is immutable (a DB trigger blocks UPDATE/DELETE once released); a correction is
  a **new version** row.
- A firm never receives an institutional cut of itself — no code path produces
  one. **Zero participating firms** is a distinct "nothing to produce" state,
  never a suppression.

### Part A — Phase 5 correctness fix

`funnel_event.segment` for institutional completions is now **derived from the
completed instrument** (`funnel-service.segmentForInstrument`): S5a →
`local_institution`, S5b → `foreign_institution`, rather than a uniform default
that silently corrupted the two distinct sufficiency floors in opposite
directions.

### ⚠️ Provisional thresholds & unlocated source documents

- The firm-report retail-cut thresholds (**10 / 29 / 30**) are a signed-off Year 1
  assumption, **provisional pending methodology validation** — held as governed
  configuration (`reporting.retail_cut_thresholds`, `is_provisional`), never a
  hardcoded constant. Same pattern as Phase 5's provisional scoring weighting.
- **Two source documents could not be located** and were not fabricated:
  `AI_REPORTING_ENGINE_BUILD_BRIEF.md` and `Report_Catalogue_closed.md` (the PRD's
  "Reporting Specification"). This phase was built from `EVIDENCE_PACK_CONTRACT.md`
  and the two design artefacts' embedded review contracts; if those documents
  surface and contain anything beyond what is here, reconcile against them.

## Setup — Results, Scores (sign-off) (Phase 7, UX-ADM-004)

The maker-checker gate on the single most consequential action in the platform:
which scoring run becomes official. This surface closes the E07 gap that Phase 6
had bridged with a stopgap.

- **Scoring is blocked while collection is open.** `triggerScoringRun`
  (`scoring-signoff-service`) hard-refuses unless the edition is `locked` — a
  real precondition on the run trigger, not a disabled button. A run against a
  changing dataset would score something that no longer exists by publication.
- **A run is made authoritative by a sign-off record, not by its status.** The
  new `scoring_signoffs` table designates which `calculation_run` is
  authoritative. A run is only eligible to back a national or firm report when it
  has a genuine `signed_off` record — enforced via `hasSignedOffRun`.
- **The record is the check.** `checked_account` is a **structured** account of
  what the signer verified (population counts reviewed, floor status reviewed,
  data-quality flags reviewed) — each item explicitly confirmed — not the generic
  4-character reason field used elsewhere. `checked_account` is `NOT NULL`.
- **Maker ≠ checker.** Enforced at the service layer _and_ as a DB `CHECK`
  (`approved_by <> requested_by`).
- **Every run is kept; supersession happens at sign-off, not at run.** A later
  run transitions the prior signed run to `superseded_run` **only when the new
  one is itself signed off** (`supersedePriorSignoffs`, inside the approval
  transaction). Superseded rows are never deleted — the who/when stays queryable
  indefinitely. Nothing already released is recalled.
- **Scores are shown before sign-off, flagged not hidden.** `getScoreView`
  reports each index's score, effective population, and floor-clear status; a
  sub-floor index is flagged (`subFloor: true`), never suppressed here — what is
  reportable is decided at the national-report stage (UX-ADM-005).
- **0–100 scale is structural.** `calculated_results.value` now carries a
  `CHECK (value IS NULL OR value BETWEEN 0 AND 100)`; an out-of-range value is a
  `validation_error`, never a silently-stored figure.

### Per-index population predicates — configuration, not code

Each index states its own population predicate in `metric_definitions.config.population`
(see `metric-definitions.ts`), **distinct** from Phase 5's general ≥1-seat
study-participation eligibility used for the 80-firm floor:

- **OMI** — firms with **all three** seats (S1, S2, S3) complete.
- **DMI** — firms with **S1 and S3** complete only (S2/compliance is irrelevant
  to digital maturity and must not be required). A firm with S1+S2 (no S3) counts
  for neither OMI nor DMI.
- **IEI / ICI / SEI** — investor-side / matched-pair populations are **not
  specified** by UX-ADM-004; they are flagged as an unresolved methodology gap
  (`population.gap = true`), never given an invented rule.

### Phase 6 integration fix (completed here)

`national-report-service.nationalApprovalPreconditions` and firm-report
generation (`generateFirmReports`, `correctFirmReport`) no longer accept a
`calculation_run` with `status = completed` as a proxy for "signed". They now
require a genuine `signed_off` record from this surface's maker-checker flow. The
Phase 6 precondition tests were updated to sign runs off through the real flow,
and a regression test asserts a completed-but-unsigned run does **not** count.

### ⚠️ Open item — `SC-005` (DECISION_NEEDED)

`SC-005` is recorded as `DECISION_NEEDED` in the requirement register and its
verbatim text is unrecovered (consistent with every other backlog item marked
this way across this programme). Per the artefact, **this surface does not invent
a rule for it.** No behaviour has been implemented for `SC-005`; it remains an
open product decision to be resolved and specified before it can be built. The
index weighting shown on this surface is likewise **provisional pending
methodology validation** (`metric_definitions.is_provisional = TRUE`) and is
displayed as "pending validation", never as a final figure.

## Setup — People & Access (Phase 8, UX-OPS-006)

The RBAC admin surface: who can sign in to study operations, what each may do,
and who holds the `request`/`approve` rights that gate the six critical actions.
It adds **no** new critical action and changes **none** of the six's own logic —
it only manages access to them.

- **Seven rights, one per-person model.** `user_permissions` is a direct
  (user, permission) grant, unioned with the role-based grants by
  `getUserPermissions`, so this surface can grant a right to one named person
  while the Phase 0/1 role-based maker-checker path keeps resolving the same set.
  The seven rights map to canonical permission codes (`ACCESS_RIGHTS` in
  `packages/db/src/queries/users.ts`): `setup` reuses Phase 1's real
  `edition:manage`; `request`/`approve` reuse Phase 0's
  `can_request`/`can_approve_critical_action` types with a NULL `action_scope`
  (= any of the six). The three that gate not-yet-built surfaces
  (`send`/`regs`/`dragnet`) exist now so no second RBAC migration is needed when
  `UX-OPS-002`/`007`/`UX-ADM-007` arrive. `view` is universal and not editable.
- **The two-approver floor is ENFORCED, not warned** — on BOTH breach routes,
  server-side (`people-access-service`): a person who is one of exactly two
  approvers cannot be removed, and their `approve` right cannot be un-ticked.
  Below two approvers a maker can never get their own request approved (the
  Phase 0 maker≠checker constraint), so **no** critical action of any kind could
  complete — a genuine platform-wide deadlock. Both refusals say what to do
  instead: give somebody else the approval right first.
- **The Dragnet analysis right does not exist for a CIS person.** Rejected
  server-side (`DRAGNET_CIS`); the form omits the checkbox entirely (not
  shown-and-refused), and changing a person's org away from Dragnet clears it.
- **A person cannot remove their own access** — refused server-side
  (`SELF_REMOVAL`) against the JWT `sub`, and the action is never rendered for
  the signed-in user's own row.
- **Two distinct failure states.** _Too few approvers_ (people still present) is
  recoverable from within the surface by granting someone else `approve`. _Zero
  people_ is a different, more severe state — surfaced honestly with **no**
  in-UI recovery path (see break-glass below).
- **Auth is out of scope.** This surface establishes who has access and what
  they may do, not how they prove who they are. A person added here is created
  with an unusable placeholder password hash and cannot sign in until
  credentials are established through a separate (Phase 0) flow.

### ⚠️ Flagged default — pending-request rights snapshot

Whether a person's rights can change while they have a critical action pending
is **explicitly undecided** by the artefact. We implement its _safe reading_ as
the default: **a pending request is evaluated against the rights held when it was
made** — the approval path (`approveCriticalActionWithRbac`) checks only the
_approver's_ rights and the maker≠checker constraint, never re-evaluating the
_requester's_ current rights. This is a deliberate default, not a resolved
product decision; if the product later wants rights re-checked at approval time,
that is a small, localized change to the approval precondition.

### 🔓 Break-glass recovery (zero-people state)

Because this surface deliberately refuses to take the estate below two approvers
and cannot recover the zero-people state, recovery from a locked-out estate is an
**out-of-band, infrastructure-level** procedure, not a screen:

1. An administrator with direct database access re-seeds an operator —
   `seedReferenceData` (or a targeted equivalent) creates a user with an
   argon2id password hash and grants the access rights directly via
   `user_permissions` (the same rows this surface writes).
2. That restored operator signs in and rebuilds the roster through the surface.

This is intentionally not self-service: an estate where nobody can sign in cannot
be the authority that restores its own access.

## Study Operations — Invitations (Phase 9, UX-OPS-002)

The operator surface for writing to firms, regulators and consented
participants. Almost every audience is a **query** against state the platform
already holds, so this phase adds only the messaging estate plus the operational
half of Phase 4's request-an-invitation flow.

- **Audiences (`invitations-service`)** — four categories, thirteen audiences,
  all resolved live: the seven firm audiences are predicates over Phase 4
  firm-claim / seat-assignment / outreach state (`all`, `newaddr2`, `unclaimed`,
  `noassign`, `partial`, `noreach`, `complete`); regulators from the provisional
  `regulator_contacts` stub; and four participant audiences that count the
  **contact-consent subset** (Phase 3 PAT-011), never the raw response count —
  "presenting the response count would imply a reach the study does not have".
  **No audience targets respondents directly**, and none exposes
  response-in-progress state (chasing participants belongs to UX-OPS-004).
- **Per-template deduplication** — a firm cannot receive the _same_ template
  twice across any earlier batch this edition, but may receive _different_
  templates. Checked at send-time against all historical batches.
- **File validation — exactly four checks** (no address / malformed / in-file
  duplicate / already-sent-this-template). There is deliberately **no fifth
  register-match check**: register/near-match resolution was removed in the
  artefact's own v3.16 — a row that resolves to nothing still sends and shows in
  the delivery report, not blocked before sending.
- **Template `{{code}}` gate** — a firm code-bearing template (claim / reminder /
  reissue) is blocked from saving unless its body contains `{{code}}`; participant
  and regulator templates have no code concept and are never forced through it.
- **Delivery reporting degrades gracefully** — sent / delivered / bounced always
  populate; `opened_at` / `clicked_at` are nullable and populate only when the
  configured provider reports them (null = _not reported_, never _zero_). An open
  is a **floor, never a reader count** and must never be published/exported/quoted
  as one; a click is a real event. Delivered-never-opened and opened-not-clicked
  are kept distinct (channel/spam vs. content).
- **Bounce handling** — there is **no resend-to-bounced action** by design; a
  bounce is resolved outside this surface (CIS supplies a replacement, or the
  firm self-serves via UX-FRM-001). The surface only lists bounced addresses.
- **Access-request queue** — a Phase 4 request-an-invitation submission
  (`submitInvitationRequest`) surfaces here with its contextual flag and is
  resolved by issuing a code or marking done.

### ⚠️ Open items for product follow-up (§10 of the build prompt)

1. **Sending service — RESOLVED (Phase 10): Zeptomail.** UX-OPS-002's artefact had
   listed it undecided among three candidates; two later, independent sources —
   the mission-board build brief's closing section and UX-OPS-001's own contract
   (`changes_from_v4_1`) — both confirm the decision landed on **Zeptomail**
   (it reports delivered/bounced/opened/clicked, the full set the board depends
   on). UX-OPS-002's note was stale, written before the decision. Phase 10
   implements `ZeptomailSendingService` behind the `SendingService` interface (no
   credential hardcoded — the token is read from `ZEPTOMAIL_API_TOKEN`, degrading
   to recording-only when unset so CI stays hermetic), and delivery events flow
   back through `ingestZeptomailEvent`. `sendBatch` now defaults to Zeptomail; a
   batch records its provider in `message_batches.sending_service`.
2. **What actually triggers `markOpened()` needs a real product decision, not a
   guess.** An earlier note assumed this surface's first send would open the
   edition. That is now doubtful: **retail (S4) collection happens through public
   entry with no firm invitation at all**, so retail responses can begin before
   any firm is invited here. Accordingly `markOpened()` is **left exactly as
   Phase 1 built it — an internal hook with no caller** — and is **not** wired to
   this surface's send. What should open an edition, given retail's independence
   from firm invitations, is flagged back to product/design.

### ⚠️ Provisional: regulator contacts

`regulator_contacts` (SEC / NGX / CSCS, seeded) is a **minimal stub** so the
"all three regulators" audience resolves. `UX-OPS-007` (regulator admin) will own
these records properly; treat the current table as provisional.

## Study Operations Home & Mission Board (Phase 10, UX-OPS-001)

The operational home: one board, one audience, answering _what needs a person
today_, ranked by consequence. Every condition is **forecast-based, never
raw-count** — a card exists only because the current trajectory threatens an
agreed outcome AND a concrete bulk action is available.

- **Forecast arithmetic** (`mission-forecast.ts`, pure & unit-tested): velocity
  (÷ `days_elapsed` before day 7, ÷ 7 after, null on day 0), required velocity,
  forecast-at-close, projected shortfall, at-risk — the brief's §4 formulas
  exactly, including the day-0/day-7 edges.
- **23-condition rule table** (`mission-board-service.ts` `CONDITIONS`): a
  data-driven table a study-team member can read against the brief. Conditions
  **6 and 21 are DISABLED** (D-1 dropped for Year 1) and carry **no threshold
  value** — specified, inert.
- **Card deduplication (§4A)**: when an Engine-1 (statistical floor) condition is
  live for a segment, every Engine-2 output depending on that segment folds into
  its Consequence — one root cause, one card (a retail shortfall is one card, not
  four). Engine-2 raises alone only when no Engine-1 covers it (heatmap 13,
  attributable-report 14).
- **Severity + clearing**: six ranks, ordered by rank then projected shortfall.
  Auto-clear only — no dismissal control. Evaluation cadence is **hourly**
  (D-5). At close (`days_remaining = 0`) forecast alerts suppress and **condition
  14 switches from forecast to actual** (§6.3); reporting-dependency alerts that
  read actuals survive.
- **Funnel diagnosis (§7B / D-2)**: the firm-side Q1-quartile rule over the four
  transitions (`invited→claimed→assigned→opened→completed`), earliest collapsed
  stage wins, default to condition 17 when none collapses, and no diagnosis below
  the 10-firm minimum population.
- **Remediation is always bulk**, handed to UX-OPS-002 (Phase 9).
- **Rail**: six phase-aware sections — real links to built surfaces
  (Invitations, Results, Setup), honest not-built stubs for the rest
  (Regulators/UX-OPS-007, Monitoring/UX-OPS-003-004, Dragnet/UX-ADM-007).

### Sending service — Zeptomail integration

`ZeptomailSendingService` implements Phase 9's `SendingService` (no credential
hardcoded; token from `ZEPTOMAIL_API_TOKEN`, degrading to recording-only when
unset). Delivery events arrive via `ingestZeptomailEvent`
(`email.delivered`/`bounced`/`opened`/`clicked` → the delivery model), so real
delivered/bounced/opened/clicked data flows through the abstraction into the
board's evaluations. `sendBatch` now defaults to Zeptomail. (Phase 9's README
open item is updated accordingly.)

### ⚠️ Interpretations & decisions flagged

- **Firm-tier scoring source (condition 13) is an INFERENCE.** The brief doesn't
  say which "operational-maturity score" tiers the firm-tier heatmap; the most
  direct available candidate is each firm's own **S1-Q2** self-rating (1–10,
  seeded Phase 2), read through the firm's S1 seat respondent
  (`getFirmMaturityScores`). Flagged so it can be corrected if a different score
  was intended.
- **§9 remediation audience-gap — decision: APPROACH 2.** For the three cohorts
  Phase 9 has no first-class audience for (`started_not_submitted`,
  `no_link_activity`, `institutional_all_firms`), the board **computes the
  firm-id list and hands it to Phase 9's existing "a list I upload" audience as a
  generated list** (`remediationForCohort(...).generated === true`). This leaves
  Phase 9 unchanged and keeps cohort definition with the board that understands
  it; the four clean cohorts use their existing audience ids, and `bounced` has
  no bulk action (export only — Phase 9 already correct).
- **`institution_engagement.target_by` is DECISION NEEDED** — study-team-set
  dates, seeded NULL. Condition 16 does not evaluate for an institution whose
  `target_by` is unset (`UX-OPS-007` will own these).
- **`markOpened()` trigger is still an open product question** — deliberately
  NOT wired to any surface's send (retail collection is independent of firm
  invitations). Left as Phase 1's internal hook.

## Candidate scoring methodology — CIS-SCORE-2026 v0.14 (Phase 11)

The real candidate scoring methodology is now integrated as the framework that
Phases 5–7 and 10 hang off. Its governing rule was **"Build the framework now.
Do not invent the methodology."** — so every weight, transform, threshold and
completeness rule is read from the single authoritative config, and where a
value is genuinely undecided the framework refuses to compute rather than
inventing one.

**The methodology's status is `TEST_UNAPPROVED`.** The load-bearing guarantee is
that a run produced under it can NEVER reach an official output — not by a flag a
reader is trusted to honour, but by a hard validation gate at every boundary.

### Sole authoritative config — the YAML was read, not reconstructed

`packages/db/src/seed/CIS_SCORING_CONFIG_CANDIDATE_v0.14.yaml` is a **verbatim
in-repo copy of the authoritative `CIS_SCORING_CONFIG_CANDIDATE_v0.14.yaml`
artefact, read directly** (via `yaml` in `scoring-config.ts`) — there is no
second, hand-transcribed copy of any weight or mapping in application code
(methodology spec §18: "No embedded duplicate config"). The build step copies the
file into `dist/seed` so runtime and tests read the same bytes. `metric_defini‑
tions` gets a **provenance-only** v14 row per index (`is_active = FALSE`,
`is_provisional = TRUE`) — live computation always reads the YAML through the
accessors, and Phase 5's active v1 config is untouched (Phase 7 behaviour is
unchanged).

### The TEST_UNAPPROVED hard gate (structural, not a label)

`assertRunOfficialUsable(pool, runId, useContext)` throws `TEST_UNAPPROVED_RUN`
for any run whose `methodology_status = 'TEST_UNAPPROVED'`. It is called at the
top of every official-output boundary, before any other work:

- `buildEvidencePack` (evidence-pack construction),
- `generateNationalReport` (AI generation input),
- `generateFirmReports` / `correctFirmReport` / `releaseFirmReports`
  (UX-ADM-006's generation and release path).

A `methodology_status` of `NULL` is a legacy/normal run — Phases 5–7 keep their
prior behaviour exactly. `runCandidateScoring` always stamps its run
`TEST_UNAPPROVED`, so candidate output is barred by construction; each of the
five boundaries has a test proving the specific failure.

### Corrected DMI/OMI completeness — item-level, not seat-level

Phase 7 approximated DMI/OMI completeness by seat state (a proxy). The candidate
methodology defines completeness at the **item** level (OPS-003 clarification),
and this phase corrects it:

- **DMI-complete** = a firm has a VALID answer to **each of S1-Q3, S1-Q8, S3-Q2**
  specifically. A firm that left **S1-Q8** unanswered is excluded **even if both
  its S1 and S3 seats are marked complete** (`dmiCompleteFirmIds`, with a test).
- **OMI-complete** = **all three role sub-indices** (CEO / Compliance /
  Operations) are calculable. A firm with no Compliance-seat answers is excluded
  and appears in the board's missing-role counts (`omiCompleteFirmIds`,
  `missingOmiRoleCounts`).

A missing / non-substantive answer (`Don't know`, `Not applicable`, blank, …) is
**MISSING (null), never neutral** — no imputation (`missing_data.imputation:
none`).

### Direction lives only in the transform binding

The eight normalisation transforms N1–N8 are read from the config; an item's
direction is encoded **solely** in which transform it is bound to
(`item_transform_binding`). There is deliberately **no `_reverse` flag and no
inference from item names** — `scoreItem('S1-Q5', …)` is decreasing because
S1-Q5 → N2 (`negative_1_10`), not because of anything about the item's name.

### Firm-scope aggregation reuses the Phase 2 `scope` flag

A firm-specific ICI/IEI never copies a shared market-level answer. `getFirmAttri‑
butableInvestorAnswers(..., { firmSpecificOnly: true })` filters on
`instrument_questions.scope = 'firm_specific'`, so e.g. **S5b-Q1 (shared) is
excluded structurally** while S5b-Q2/Q3 (firm_specific) are kept — proven with a
test.

### Public pooled headline + mandatory composition disclosure

`pooledHeadline` is a **plain arithmetic mean of all valid investor-unit scores
from reportable segments** — NO equal-third weighting. A segment that fails its
reportability floor is excluded from **both** the numerator and the denominator
(not merely flagged), and every result carries a **mandatory composition
disclosure** line as a structured field (never optional prose).

### Industry SEI is NOT_CALCULABLE — a methodology block, not a shortfall

The Industry-SEI minimum firm-investor-observation floor is `PENDING_VALIDATOR`
in the config, and **`engineering_may_invent_value: false`**. So Industry SEI is
recorded as `NOT_CALCULABLE` — a NEW sufficiency state, DISTINCT from
`SUPPRESSED`. SUPPRESSED is a data problem (more fieldwork fixes it);
NOT_CALCULABLE here is a methodology problem only a methodology-partner approval
fixes. On the Mission Board it surfaces as a dedicated **methodology-block card**
with **no cohort and no remediation** (chasing respondents cannot resolve it),
exempt from the "no action → off board" filter so it always displays, and it
survives close.

### Mission Board conditions 7/8 now track the complete-forecasts

Conditions **7 (OMI at risk)** and **8 (DMI at risk)** are evaluated against the
item-level **OMI-complete / DMI-complete forecasts** — how many firms will be
complete by close — **not raw firm participation**. A firm can participate yet be
neither OMI- nor DMI-complete, so these fire (as their own cards, no longer
folded into the firm participation card) even when firm participation is on
track.

### Like-for-like cross-edition comparison

When two editions' reportable segment sets differ, a direct headline comparison
is refused (`canCompareHeadlinesDirectly`). `recordLikeForLikeComparison`
persists a new, separately-immutable **`LIKE_FOR_LIKE_RECALCULATED`**
`comparison_runs` row that restates both editions on the common segment set and
**preserves both original published headlines** — it never mutates a source run.

### ⚠️ §8 threshold conflict — flagged for reconciliation, NOT silently merged

The build prompt's §8 introduced firm/investor reporting thresholds that overlap
the Phase 6 retail-cut thresholds already governed at
`reporting.retail_cut_thresholds` (directional 10 / reportable 30). Rather than
overwrite one with the other, the two are kept as **separate governed-config
keys** pending a reconciliation decision:

- `reporting.retail_cut_thresholds` — Phase 6's FRM_04 retail cut (unchanged:
  10 / 30).
- `reporting.firm_investor_thresholds` — the §8 firm/investor floors (headline
  20, gap 30, binary 75–100, shared 15, sub-segment 15), marked
  `provisional: true`.

Both are provisional and configurable. **This conflict needs a
methodology/product decision** on whether the retail cut is a special case of the
firm/investor thresholds or a genuinely distinct rule; until then neither value
is lost and neither silently wins.

### ⚠️ Framework interpretations flagged pending methodology approval

- **OMI role sub-index calculability bar.** The config mandates DMI's required
  items explicitly but for OMI states only `all_three_role_subindices_required`
  with a `mean` operator and no per-sub-index minimum-valid-item threshold. The
  framework reads this as "a role sub-index is calculable when it has ≥1
  substantive contributing item" (the standard mean-of-valid reading) and does
  **not** invent a stricter threshold. Flagged in `getOmiRoleItemGroups` for
  confirmation.
- **Nothing here computes an official score.** Every candidate value is
  `TEST_UNAPPROVED` and cannot leave the framework until the methodology is
  approved and its `PENDING_VALIDATOR` parameters are set.

## Regulator Engagement (Phase 12 — UX-OPS-007)

The surface for engaging the three regulators (SEC, NGX, CSCS) that contribute
the Institutional Perspectives section. **One page per regulator, two sections in
fixed order** — the contact, then the survey — plus an append-only free-text
history. Three states only: no contact → contact added → invited, with the
terminal outcomes confirmed / declined. Reached from Study Operations; the
`RegulatorsPage` admin tab is a faithful port of the approved v2.5 artefact, and
the authoritative behaviour lives in `regulator-engagement-service.ts` + the
`regulators.ts` API routes.

### It closes Phase 10's `target_by` gap directly

Phase 10 flagged `institution_engagement.target_by` as DECISION NEEDED with no
owning UI. **This surface is that UI.** Issuing a survey link is where the study
team sets that regulator's own lead time, and the write lands in the SAME
`institution_engagement` row Phase 10's condition 16 reads — there is no second,
parallel date field. This phase extends that one row with the named contact and
the issued survey link, and formally takes over the two artefacts Phases 9/10 had
left provisional (the raw institution-engagement setter that used to sit on the
mission-board route is gone — a lead time is now only ever set through the gated
`issue-link` flow). Condition 16, permanently inert while `target_by` was NULL,
becomes evaluable the moment a real date is set here (gate test proves both
halves).

### Contact-before-survey ordering is a real server-side precondition

`issueSurveyLink` refuses (`CONTACT_REQUIRED_FIRST`) unless a saved contact
exists — the order on the page is the process, not just UI sequencing. Contact
validation enforces name, role, a valid email, a valid phone (**≥10 digits after
stripping non-numeric characters**) and a "how we got to them" note; the email
and phone checks are independent hard failures with their own codes
(`CONTACT_EMAIL_INVALID`, `CONTACT_PHONE_INVALID`) — "a number too short to send
a text is worse than no number: it looks like a working channel."

### Named individuals — the one deliberate exception

This is the **only** place in the organiser estate that holds a named individual
(who / role / email / phone) outside the firm register, because engagement is a
relationship. It is **not** tokenised or anonymised. The respondent that backs
the survey link, by contrast, stays anonymous — the named relationship lives on
the engagement record, the survey token does not carry it.

### A real per-regulator survey token (unblocks UX-INS-003)

Issuing a link mints a genuine respondent for the regulator's `I-{code}`
instrument and a `recovery_token` that resolves via `GET /journeys/resume/:token`
(`getResumeByToken`) — a working entry into the Phase 3 survey runtime, not a
placeholder URL.

### Referral is cancel-and-restart; declined is terminal; reminders stay loose

- **Referral**: changing the contact on an already-invited regulator IS the
  referral — the earlier link dies (its token is revoked, any partial answers
  lost), `target_by` is cleared, the survey resets to `none`, and the loss is
  logged. No multi-hop chain is modelled — it's three phone calls, not a
  workflow.
- **Declined** is a distinct, terminal outcome for the edition: no reminder or
  issue action is offered against a declined regulator.
- **Reminders** are two loose channel actions (email+text together, or text-only
  for a clearly-unread inbox) — deliberately NOT a numbered escalation tier.
  Everything else about chasing is free text in the append-only history, which is
  what a phone call produces — no typed contact-event taxonomy.

### Internal "Regulators" label never reaches a reader

The internal grouping label is loose ("Regulators", which is imprecise for CSCS —
clearing and settlement infrastructure). That looseness is accepted deliberately
for internal ops, and a regression test confirms Phase 6's published PUB_10
Institutional Perspectives section still frames CSCS as **clearing and
settlement** (market infrastructure), never mislabelling it a regulator.

### ⚠️ Open item — declined-regulator re-approach (unresolved study decision)

**Whether a regulator that declined in one edition can be re-approached in a
later edition is a study decision, and is deliberately NOT built here.** No
re-approach workflow and no permanent cross-edition lockout is invented — declined
is simply terminal within its edition. Flagged as an open item, consistent with
every other genuinely unresolved item on the programme.

**Partially closed by Phase 19** — a MISTAKEN decline within the SAME edition
can now be corrected (`reopenDeclined`, `access:regs`-gated, no maker-checker).
The cross-edition question above is untouched and remains open.

## Responses Monitoring & Reminder Timing (Phase 13 — UX-OPS-003 / UX-OPS-004)

Two monitoring surfaces plus two corrections to already-shipped Phase 10 code.

### Part A — two corrections to shipped Phase 10 code

**A1. The firm-side funnel diagnosis is now FOUR DETERMINISTIC STATES, not
quartiles.** UX-OPS-003's external QA found that "with one invitation and three
respondents per firm, conversion takes four possible values — 0, 33, 67, 100 per
cent — and a quartile over four values is not a diagnosis." `diagnoseFirmFunnel`
(`mission-forecast.ts`) previously computed each stage's Q1 across firms and
flagged firms below it. It now names the earliest deterministic state a firm is
stuck in — **not_claimed → claimed_not_assigned → assigned_not_opened →
opened_not_completed** — each with its own remedy (chase the firm / coordinator /
respondents), no comparison and no minimum population. **Q1 quartiles are
preserved for the investor side only** (`firstQuartile` stays exported and
documented as investor-only). A regression test proves the firm side no longer
re-derives from quartile math: uniform failure (every firm equally stuck) — which
the old Q1 rule hid as `healthy_default` because nothing was an outlier — is now
named as the stuck state.

**A2. No investor-side rate uses a "sent" denominator.** The investor funnel is
`opened → started → completed`; the platform cannot know a firm's send volume, so
an open-rate against sends is not calculable. A sweep confirmed no investor-side
ratio ever divided by a sent/invited count — investor monitoring is entirely
forecast-based on completed counts, and velocity divides by DAYS, never sends. A
regression test asserts this (`buildSegmentForecast` has no sent input; velocity =
completes ÷ days).

### Part B — UX-OPS-003 Responses monitoring

- **Single source of truth (§B2).** `getResponsesMonitor` reuses
  `buildBoardContext` — the mission board's OWN computation — so the complete-firm
  risk it shows and the board's conditions 7/8 read one function, not two. A test
  changes the seeded data once and asserts both surfaces reflect it identically.
- **Complete-firm status is a STRUCTURED line (§B3),** not prose: the
  participating-firms card carries OMI-complete and DMI-complete as their own
  `{metric, requiredInstruments, current, forecast, state}` lines, so
  "participating on track / completion projected to miss" can never disappear into
  a paragraph.
- **The firm report is TWO dependency rows (§B4).** The **combined** report is
  always `guaranteed` (Phase 6 guarantees FRM_01/02/03 regardless of volume — "at
  risk means thin, not withheld"); the per-firm **category cuts** read **"Some
  suppressed"**, never "At risk", because per-firm suppression is designed
  sufficiency gating, not a failure. A seeded `PARTICIPATING_FIRM_REPORT_CATEGORY_CUTS`
  row makes the split real, and a test asserts neither firm-report row ever uses
  at-risk vocabulary.
- **Net-new distinct institutions (§B5).** Institutional current/velocity count
  `COUNT(DISTINCT institution_ref)` — a test proves a second response from an
  already-counted institution does not inflate `current` or `velocity`.
- **Cards report; the board acts (§B6).** Each segment card links to its board
  condition (firm→1, retail→2, local→3, foreign→4) and carries NO action of its
  own — two places offering the same action is how they drift apart.
- **`report_dependency.required_instruments` (§B7).** A new explicit column: any
  firm-referencing output declares exactly which firm-side instruments it needs
  (OMI = S1+S2+S3 complete; DMI = S1+S3 DMI-complete), never falling back to
  whichever population is convenient at write time.

### Part C — UX-OPS-004 Reminder timing (investor-side only)

- **Relative timing (§C1).** Each reminder fires at `last_activity_at + N days`
  (derived from the latest autosave), never against a shared calendar date.
- **Drop-off by last question (§C2).** `getDropoffHistogram` buckets every
  in-progress response by its last-answered `question_id` — a cluster is a
  question doing damage, actionable in a way an aggregate rate is not.
- **The unreachable ceiling is stated, not hidden (§C3).** `getUnfinishedStats`
  surfaces the unreachable cohort as a number, using the same contact-consent
  predicate Phase 9 uses for participant audiences.
- **STOP after the first only (§C4).** `carries_stop` is a send-sequence flag
  (false on the first ever reminder to a person, true on every subsequent one) —
  message content stays UX-RET-007's, which isn't built yet; a clearly-labelled
  placeholder stands in.
- **Governed cap and schedule (§C5).** `reminders.cap` and `reminders.schedule`
  are governed config, seeded with the starting position (2 days, 7 days, and a
  final step 3 days before close) and editable during fieldwork — never hardcoded.
- **Live close-date reference (§C6).** The closing-week step is computed as
  `edition.closes − N days` on every run, so moving the close date (allowed while
  the edition is open) moves the reminder without any re-save. A test proves it.
- **Completion boundary (§C8).** The engine schedules sends into an append-only
  `reminder_send` ledger and never touches response state; a completed (submitted)
  response is never reminded.

### ⚠️ Open item — firm-side respondent reminders (unresolved)

**Whether a firm-side respondent (someone answering S1, S2 or S3) is reminded on
the same schedule as an investor is NOT decided,** because they are reached
through the firm rather than directly. This reminder engine is deliberately built
for **investor-side (retail/local/foreign) participants only**; firm-side
seat-holders remain UX-OPS-002's bulk, coordinator-routed messaging (Phase 9). A
test asserts no reminder fires for an S1/S2/S3 seat response under this engine.
Flagged, not guessed at.

### 📄 Calculation-brief note for future readers

`OPS_RESPONSES_CALCULATION_BRIEF.md` v1.0 predates UX-OPS-003 by one day and
misses two of that artefact's own corrections. Its **§6.3 (firm-side quartile/Q1
diagnosis)** is superseded by the four deterministic firm-side states above, and
its investor-funnel wording that could imply a **"sent" denominator** is
superseded by the `opened → started → completed` investor funnel. The artefact is
the executable authority where the two conflict (the same precedent applied across
this programme); the brief remains correct for the segment cards, the distinct-
institution rule, the dependency map, and the edge cases.

## Firm Private Results (Phase 14 — UX-FRM-RES-001)

The display surface that finally lets a firm SEE the report Phase 6 built the
pipeline to produce. It READS existing scoring output — it computes no new scores
and applies NO secondary scaling.

### Comparison direction is DERIVED, never hand-set (the v1.0 defect)

The artefact's own history records a serious correctness bug: v1.0 hand-set a
"better-than" flag per index, so the SEI **gap** index got a **score** index's
comparison and read a gap of 1.3 against 1.8 as _above the benchmark_ — the exact
inversion. The fix, implemented verbatim: `standing(you, industry, gap, margin)`
returns `true` (better) / `false` (worse) / `null` (inside the margin), and the
`gap` argument comes from **one** derivation point — `isGapIndex(code) === (code
=== 'SEI')`. SEI is structurally the service-excellence gap (lower/narrower is
better); OMI/DMI/IEI/ICI are scores (higher is better). There is deliberately **no
per-index `is_better_if_higher` flag in any schema or config** — a second hand-set
flag is exactly the mismatch that recurred as the "third instance of the same
class" across this estate. A test drives both a gap and a score index through the
same `standing()` with no per-index override.

### 0–100 shown verbatim; provenance from the real composition

The signed framework scores every index 0–100 so results compare across firms,
segments and years. `getFirmResults` reads `calculated_results.value` directly and
applies **no** transform (a test asserts a stored 68 renders as 68). Each index
states which side it comes from, **derived from its `metric_definitions`
composition** (`config.population.kind`): firm-seat indices → "From your own three
surveys", investor-response indices → "From investors who rated you", the
matched-pair index (SEI) → "Your answers against what investors reported" — not
hardcoded prose disconnected from the calculation inputs.

### Reuse, single source, permanent nevers

- The **retail category cut** reuses Phase 6's `cutStateFor` + governed
  thresholds (10/30) — no second threshold check. The **combined report is
  unconditional**: it renders regardless of response volume; only how far it can
  be broken down varies, and the copy says so.
- The **industry benchmark** is the anonymised aggregate from the shared
  `getScoreView` (mean of per-firm values) — there is **no** ranking, no other
  firm named, and no endpoint that could return another firm's score, name, or
  rank.
- **No institutional cut at firm level, ever** — arithmetic, not policy (25 local
  / 15 foreign institutions nationally; no single firm reaches a credible
  institutional sample). The service structurally returns only the five indices.
- Figures reflect investors who **rated** the firm (`rated_firm_id`), regardless
  of arrival route — never investors who merely came through the firm's outreach
  link. A test seeds a respondent arriving via a _different_ firm's link that
  rates this firm, and one arriving via this firm's link that rates another, and
  proves attribution (not route) decides inclusion.
- A difference **inside the margin makes no claim** (`standing()` → null),
  rendered as neutral, informational text — never styled good or below.

### ⚠️ Governed `MARGIN` (§6)

`reporting.comparison_margin` is governed config seeded at **3** (matching the
artefact), never a literal and never per-index — one margin for all indices. It is
provisional and **flagged for reconciliation alongside the other still-open
sufficiency-threshold questions** (`retail_cut_thresholds`,
`firm_investor_thresholds`, and the Industry-SEI floor from Phase 11).

### ⚠️ Interim access default (§9)

Access is **coordinator-only** for this phase — the more conservative choice,
consistent with the coordinator being the platform's addressable party. It is
verified by the firm's coordinator access code (there is no coordinator login
surface yet; this is the estate's first coordinator-authenticated surface). Whether
the coordinator alone sees this or all three respondents is an access question
owned by UX-FRM-007 and **not decided here** — this is an interim default, flagged,
not a resolved design choice. A test proves only a coordinator of the firm can
view it (a different firm's coordinator, or any other code, is refused).

### 📐 Twelve-month active-broker scoping readiness (§8)

Investors answer firm-specific questions only for brokers actively used in the
past twelve months, so a firm sees its recent clients free of dormant accounts.
No such recency window existed anywhere (Phase 2/3 rating eligibility only checks
active-participant status), so a pure, structurally-ready `withinActiveBrokerWindow`
helper (`ACTIVE_BROKER_MONTHS = 12`) is added for 2027+. In **Year 1 this is moot**
— with a single edition, every rating is within the only window that exists — so it
has no visible effect now, but the concept is present rather than absent.

### 🅿️ Parked, per the artefact (not built)

The premium "why you sit here" diagnostic, a firm-level shared-investor
(multi-broker) comparison, and an investor subsegment-by-portfolio-band view are
all explicitly parked for Year 1 and deliberately not built.

## Dragnet Internal Analysis (Phase 16 — UX-ADM-007)

Dragnet's own commercial analysis tool, built on the MOU's revenue-sharing terms
with CIS. Gated to users with `access:dragnet` — CIS-org users are structurally
refused this right (Phase 8). The surface is absent from navigation (not shown as
"access denied") for users without the right.

### The join boundary is structural, not conventional

**Firm-level maturity and DRG-OPS operational friction data are NEVER joined.**
Two entirely separate query paths — `getFirmMaturityRows` and `getDrgOpsAggregate`
in `packages/db/src/queries/dragnet.ts` — enforce this at the function signature
level: neither function touches the other's tables, and no shared JOIN path
exists. The domain service (`packages/domain/src/dragnet-service.ts`) routes each
API endpoint to exactly one of these paths. Tests in
`packages/domain/tests/dragnet.test.ts` actively assert the impossibility of
querying DRG-OPS content alongside any firm-identifying column (§1,
join-impossibility).

**Why this matters:** combining them would turn the benchmark into a product that
profiles individual firms for selling, which is what CIS declined. The separation
is a condition of the MOU, not a UI preference.

### Consent boundary — absent, not masked

Contact details appear only for firms that gave follow-up consent (Phase 4's
`firm_claims.follow_up_consent`). A non-consented firm has `contact: null` in the
query result — the field is genuinely absent, not an empty string, not masked, not
greyed out. The CSV export uses the **same** `getFirmMaturityRows` call as the
screen (not a separate export query), so the consent boundary is identical in both
paths.

### Tier is a fixed property of the OMI score

`assignTiers()` in `dragnet-service.ts` partitions firms by their OMI value —
top third, bottom third, middle third — and records the tier as a stable property
of the `FirmMaturityEntry`. It never derives tier from row position in a sorted
list. The UI can re-sort the table in any order without changing any firm's tier.

### ⚠️ Open item — DRG-OPS friction minimum-population floor (UNRESOLVED)

The operational friction views aggregate DRG-OPS responses across all respondents
for an edition, but at low response volume the aggregate is statistically
less meaningful. **No minimum-population floor has been set for this view.**

This threshold should follow the same reasoning as the platform's other
sufficiency floors — the reporting floors (retail cut 10/30, directional vs.
reportable thresholds), the institutional-completions floor, and the sample floor
configuration in `edition_sample_floors` — rather than being invented
unilaterally in this phase. Setting it requires the same kind of methodology and
legal alignment those floors went through.

**This is an open item for the study team and Dragnet to resolve jointly.** The
friction view computes and displays correctly at any volume; the floor decision
controls when it is safe to act on the result, not whether the arithmetic runs.

Until the floor is set, the friction tab is displayed without a minimum-volume
gate. A governed-config key (`dragnet.friction_min_population`) should be
introduced when the floor value is agreed, following the same pattern as
`reporting.retail_cut_thresholds`.

---

## Phase 17 — UX-RET-007 v2.3: Reminder & Recovery Message Content

### §2 STOP-language verification (Phase 13 bug corrected)

Phase 13's `nextDueReminder` contained a bug:

```typescript
// WRONG (Phase 13 original)
carriesStop: params.sentSteps.length >= 1;
```

This made step 1 (the 2-day relative reminder) carry `carriesStop = false`, incorrectly
exempting the first scheduled reminder from STOP language.

Per the UX-RET-007 v2.3 artefact, the **only** STOP-free message is the separate one-time
initial link delivery at consent time (Phase 3/9). That message is not produced by the Phase 13
reminder engine at all — it is sent once, at the moment a participant provides contact details,
and is not part of the scheduled cadence. Every step the Phase 13 engine dispatches is a
reminder, and every reminder must carry STOP.

The fix:

```typescript
// CORRECT (Phase 17)
carriesStop: true;
```

All three timing-test assertions that expected `carriesStop = false` for step 1 have been
updated to `true`, and the Gate 1 DoD test in `reminder-content.test.ts` explicitly exercises
each step including step 1.

### WhatsApp (DEC-010)

No WhatsApp message variants were built. DEC-010 superseded the WhatsApp channel with
text/SMS. The `ReminderSubKey` type has no WhatsApp entries; the seed migration creates
no WhatsApp content rows.

### `reminders_opted_out` — structural separation from consent and participation

The `reminders_opted_out BOOLEAN NOT NULL DEFAULT FALSE` column on `respondents` (added in
migration `20260907000000_phase17-reminder-content.js`) is the only field that STOP/opt-out
touches.

- `optOutReminders` updates only `reminders_opted_out`. It does not touch `consent_accepted`,
  `submitted_at`, `contact_channel`, `contact_email`, `contact_phone`, or any other column.
- A respondent who opts out of reminders remains fully eligible to complete and submit their
  response. Their token is still valid; they can return and submit normally.
- Gate 5 in `reminder-content.test.ts` asserts this explicitly: after `optOutReminders`, the
  test queries `consent_accepted` and `submitted_at` directly and asserts they are unchanged,
  then asserts `markRespondentSubmitted` still succeeds for the same respondent.

### SMS single-segment constraint

All SMS sub-keys (`first_message_text`, `reminder_text`) must produce a body of ≤ 160 characters
when the longest expected recovery URL is substituted. The `saveDraft` domain function enforces
this at write time via a private validator that:

1. Replaces `{{recovery_url}}` with a 70-character representative URL.
2. Strips any remaining `{{…}}` placeholders.
3. Asserts the result is ≤ 160 characters.

Both seeded SMS templates fit comfortably within this budget:

- `first_message_text`: ~138 characters (68 fixed + 70 URL).
- `reminder_text`: ~143 characters (62 fixed + 11 STOP suffix + 70 URL).

Gate 2 in `reminder-content.test.ts` reads the live seeded content from the database and
verifies both fit within the limit.

### Content managed through Phase 15 admin UI

Phase 17 adds `reminder_content` as the seventh managed-content area, reusing Phase 15's
`content_versions` + `content_live` tables, `saveDraft` / `publishDraft` / `getLiveContent`
functions, and the admin UI at `/managed-content`. No new content store was introduced.

The seven sub-keys seeded at migration time:

| Sub-key               | Channel | Notes                                                                    |
| --------------------- | ------- | ------------------------------------------------------------------------ |
| `first_message_email` | Email   | JSON — subject, body, cta. No STOP (one-time delivery at consent).       |
| `first_message_text`  | SMS     | Plain text with `{{recovery_url}}`. No STOP.                             |
| `reminder_email`      | Email   | JSON — subject, body, cta, stop_link_text. Carries STOP.                 |
| `reminder_text`       | SMS     | Plain text with `{{recovery_url}}`. Carries STOP via inline STOP suffix. |
| `reminders_stopped`   | Web     | JSON — heading, body, study_home_cta, recovery_link_cta.                 |
| `already_submitted`   | Web     | JSON — heading, body.                                                    |
| `link_tapped`         | Web     | JSON — heading, body.                                                    |

### Progress wording is computed, not fixed

`computeProgressWording(answered, total)` in `reminder-content-service.ts` derives a human
phrase from the respondent's actual answered-item count relative to the total items for their
instrument. It returns different phrases for different completion ratios. Gate 3 asserts that
two respondents at ~15% and ~54% completion receive different wording.

### Channel inheritance

The reminder delivery channel is the `contact_channel` set at Phase 3/9 consent time. The
Phase 17 service reads it from the respondent record and never overrides it. Gate 4 asserts
that after setting `channel: 'text'` at consent time, the same value is present on a
subsequent fetch by recovery token.

---

## Phase 18 — Final planned surfaces: investor categories, firm digest, previous editions, help/privacy/about, shared error states

This completes the originally-scoped 33-surface estate (`UX-FRM-002`, `UX-FRM-DIG-001`,
`UX-PUB-002`, `UX-X-002`, `UX-X-001`, all v1.1).

### UX-FRM-002 — Investor categories served (provably inert)

`organizations.investor_categories_served TEXT[]` is a firm's own multi-select declaration
(retail / local institutional / foreign institutional / not sure). `investor-categories-service.ts`
is the _only_ file that writes it. A gate test enumerates every other file in `packages/domain/src`
and asserts none references `investorCategoriesServed` / `investor_categories_served` — the
inertness claim is checked by source inspection, not just by convention. Editable at any time by
the firm's coordinator (`PUT /firm/:orgId/investor-categories`, `app.authenticate` only, same as
every other firm-portal self-service field) — no critical action, no maker-checker.

### UX-FRM-DIG-001 — Firm digest

`firm-digest-service.ts` assembles counts and state flags only — seat completion (Phase 4),
investor-contribution counts by segment (Phase 5's `firm_id`-attributable `funnel_event` rows,
reused via a new `getFirmSegmentContributionCounts` query), and a "what needs attention" state
reusing Phase 4/9's existing `noassign`/`partial`/`noreach`/`complete` firm-audience predicate
(exported as `getFirmAudienceState`, no new derivation logic). `packages/db/src/queries/firm-digest.ts`
is a deliberately narrow file: it never joins to `responses` or `respondent_drafts`, and never
selects a `question_id` or `respondent_id` — a gate test strips comments and greps the actual code
for those tokens, so the boundary is structural, not just documented. Delivery reuses Phase 9's
`SendingService` (defaulting to `ZeptomailSendingService`, matching `sendBatch`'s own convention)
sent to the firm's lead coordinator's already-validated email (Phase 3's `firm_coordinators`).
Frequency and channel are governed config (`firm_digest.schedule`), per the artefact's own
statement that these are implementation configuration, not a design decision.

### UX-PUB-002 — Previous editions

Year 1 renders the empty state. The underlying query (`getPreviousPublishedEditions`) lists every
edition's approved `national_reports` row other than the current edition, oldest-to-newest per
edition — no new mutation logic, no new immutability mechanism. `national_reports` already
supports multiple approved rows per edition ("one per edition, signed scoring run" — no unique
constraint on `edition_id` alone), so a correction is naturally a second approved row; the query
labels the first as `"Original publication for this edition."` and any later one as
`"Correction — supersedes the version approved on <date>."`, read out of existing state rather than
a new flag.

### UX-X-002 — Help, privacy and about

All four sections (privacy/confidentiality, about CIS, about Dragnet, help) read from Phase 15's
managed-content system via `getPublicContent` — nothing is hardcoded in the consuming surface.
`privacy_notice` resolves through `governed_config` exactly as Phase 15 already routes it;
`organisation_descriptions`/`help_text` resolve through `content_live`. `organisation_descriptions`
keeps its single existing sub-key (`''`) from the Phase 15 seed, with its body reinterpreted as
`{"cis": "...", "dragnet": "..."}` rather than adding two new sub-keys — no change to Phase 15's
admin editing surface was needed.

**Forbidden-phrase check** (the inverse of Phase 15's required-clause check): a new
`forbidden_phrases` table (mirrors `required_clauses`'s shape) blocks `saveDraft`/`publishDraft`
for `privacy_notice` if the body contains an absolute-anonymity claim ("completely anonymous",
"fully anonymous", "totally anonymous", "100% anonymous", "no record is kept"). This is a real
constraint, not an editorial nicety: a respondent's session can be linked server-side to their
response for recovery/immutability purposes (Phase 3's recovery token, Phase 17's reminder
delivery) — never exposed to firms or the public, but real, so a "completely anonymous" claim
would be false. The check runs at both save and publish time, matching the required-clause
check's own two enforcement points.

### UX-X-001 — Shared error, access and permission states + withdrawal

**Consolidation, not a sixth page.** `shared-error-service.ts` defines the five canonical states
(`expired_link`, `no_unfinished_survey`, `access_denied`, `service_unavailable`,
`participation_closed`) and their copy in one place; `apps/admin/src/shared/ErrorState.tsx` is the
one React component every surface should render them through. This phase retrofits two real ad-hoc
error surfaces rather than leaving the component unused alongside them:

- `apps/admin/src/journey/RespondentApp.tsx` — the resume-by-link flow. This retrofit also fixed a
  real bug: the code assumed every `resumeByToken` response had a `.respondent` field, which
  crashes for `already_submitted` and would have crashed identically for the new
  `participation_closed` kind. It now switches on `kind` and renders `ErrorState` for
  `no_unfinished_survey` (an unknown token, 404), `participation_closed` (withdrawn), and
  `service_unavailable` (any other failure).
- `apps/admin/src/App.tsx` — the operator shell's edition-load failure now distinguishes a genuine
  service failure (5xx / network, → `ErrorState kind="service_unavailable"`) from a recognized 4xx
  operational message (e.g. "no edition exists yet — seed the database", which is not one of the
  five states and keeps its own text).

**Not retrofitted in this phase** (documented, not an oversight): `expired_link` and `access_denied`
are not yet produced by any live code path — no recovery-token TTL-expiry check exists yet (tokens
don't expire), and no admin surface's 403 has been switched over. The component supports all five
states today (a gate test renders each and asserts non-empty title/detail), so wiring a future
producer in is a one-line change, not a redesign.

**No-leakage.** The `no_unfinished_survey` state is produced by `GET /journeys/resume/:token`'s 404
branch, whose reply is the fixed literal `'No journey for this recovery link'` — no template
interpolation, no respondent id, no answer fragment. A gate test both confirms
`getRespondentByRecoveryToken` returns `null` (never a partial record) for an unknown token, and
greps the route source to confirm the literal has no `${...}` interpolation.

**Withdrawal (§5 gap, closed minimally).** `respondents.withdrawn_at TIMESTAMPTZ` is a genuine
withdrawal flag, structurally distinct from Phase 17's `reminders_opted_out` (which Phase 17
explicitly documented as _not_ withdrawal). `journey-service.ts`'s `saveDraftAnswer` and
`submitJourney` both check it and throw `ParticipationClosedError` (mapped to HTTP 403) if set;
`GET /journeys/resume/:token` returns `{ kind: 'participation_closed' }` before checking
`submittedAt`. Setting the flag is `POST /respondents/:id/withdraw` — operator-authenticated only
(`app.authenticate`, no special permission), living next to the other monitoring routes.

**Deliberate scope boundary — no self-service withdrawal flow.** There is no respondent-facing
"request to withdraw" UI, no approval step, and no confirmation email. The artefact does not
specify one, and no prior phase built one; inventing a request/approval flow now would be scope
creep beyond what was actually asked for. If the study team wants participants to be able to
request withdrawal themselves, that is a new, unscoped surface for a future phase — this phase
delivers exactly "the flag, the check, and this error message," as instructed.

### Stale-package note (per this phase's own instructions)

`UX-FRM-002`'s `PACKAGE.md` named v1.0 (2,689 bytes) as current; the actual artefact supplied was
v1.1 (8,382 bytes). Per the same stale-package precedent settled repeatedly on this programme, the
registry (the artefact actually supplied and hash-verified) wins — v1.1 is what was built. The
backlog's earlier `RECONSIDER` flag on this surface is resolved by the final design itself, which
makes the whole declaration explicitly optional and non-binding; it is treated as approved-as-shown.

### Consolidated open business decisions (§8)

The engineering build is now substantively complete for the originally-scoped 33-surface estate.
The following are non-engineering-resolvable business/compliance decisions accumulated across prior
phases, documented here as one list for whoever owns that side of the programme:

1. **Institutional Q5 wording** (I-SEC-Q5, I-NGX-Q5, I-CSCS-Q5) — flagged in Phase 2's seed as
   PENDING correction as of the 2026-08-20 freeze; needs compliance sign-off against the current
   controlled Register before any production edition freeze.
2. ✅ **CLOSED by Phase 19** — **`markOpened()`'s trigger** (Phase 9) is now wired: a study-team
   configured `plannedOpenAt` instant, lazily evaluated on every edition read
   (`evaluateAutoOpen`). See Phase 19's section below.
3. **Phase 11 threshold conflict and approval item** — the candidate-scoring config's threshold
   values need methodology sign-off; a related approval step is still open.
4. **Declined-regulator re-approach question** (Phase 12) — **partially closed by Phase 19**:
   within the SAME edition, an `access:regs` holder can now reopen a mistaken decline
   (`reopenDeclined`). Whether a regulator that declined in one edition can be re-approached in a
   **later** edition remains the unresolved cross-edition question this item originally named.
5. **DRG-OPS friction minimum-population floor** (Phase 16) — no floor has been set for the
   operational friction view; needs the same methodology/legal alignment as the platform's other
   sufficiency floors.
6. **Genuine withdrawal _request_ flow** (this phase, §5) — the flag and check exist; a
   respondent-facing self-service request/approval flow does not, and is unspecified in any
   artefact seen so far.

None of these block the engineering already delivered; they are the open questions for the study
team, CIS, and Dragnet to resolve jointly.

### Bugs found and fixed while wiring this phase against a live database

Two pre-existing defects in Phase 17 code surfaced only once gate tests actually ran against
Postgres (they had not been runnable in the prior session's environment):

- `getRespondentProgress` (`monitoring.ts`) joined `respondents.instrument_code` directly to
  `instrument_questions.instrument_code` — a column that does not exist. `instrument_questions`
  links to `instrument_definitions` (which holds `code`) via `instrument_definition_id`. Fixed by
  joining through `instrument_definitions`.
- The seeded `reminder_text` SMS body measured 163 characters with a 70-character URL substituted
  — 3 over the 160-character single-segment budget. Shortened "Your answers are saved." to
  "Answers saved." (154 chars). Fixed in both the production migration and the test-seed helper
  (`seedManagedContentDefaults`), which previously did not seed `reminder_content` at all — any
  test that truncated tables before exercising Phase 17's reminder content lost the migration's
  seed permanently for the rest of that test run. Both are now real content, not something that
  merely typechecked.

## Phase 19 — Institutional Instrument Families & Closed Engineering Decisions

Re-architects the three hardcoded institutions (SEC/NGX/CSCS) into a genuinely reusable model,
per the controlled `CIS_Institutional_Instrument_Families_Register_Extension` v1.1, and closes
seven previously-tracked open business decisions from prior phases — three already correct
(closed here in documentation only), four needing real engineering.

### Closed without engineering — already correct

Per the controlled closure document, three previously-open items were confirmed already built
correctly and needed no code change: target dates (Phase 12's per-regulator `target_by`, not a
shared deadline), the sufficiency-threshold architecture (the generic `computeSufficiency()`
ladder in `sufficiency-service.ts`, reused rather than duplicated — see Item 5 below, which
leans on exactly this), and respondent withdrawal (Phase 18's flag-and-check, without a
self-service request/approval flow — see the Phase 18 section's own scope note, unchanged).

### Item 1 — Institutional instrument families

`institution -> institution role -> controlled instrument family/version -> edition
participation -> individual invitation`. Two new tables (`institutions`, `institution_roles`)
replace the fixed `RegulatorCode` enum everywhere it appeared (shared-types, DB queries, the
domain service, API routes, React). `institution_engagement` and
`regulator_engagement_history` move from a two-part key (`edition_id, institution TEXT`) to a
three-part key (`edition_id, institution_id, family_code`) — a multi-role institution (CSCS:
Family C **and** Family D) gets two independent engagement rows in the same edition, one per
role, verified in `regulator-engagement.test.ts`.

**The hard rule — adding a ninth institution of an existing role requires NO code change** —
is verified directly (`institution-families.test.ts`): inserting a new `institutions` /
`institution_roles` row and re-running `seedInstitutionEngagement` (which enumerates
`institution_roles`, never a hardcoded list) is sufficient for the new institution to appear
everywhere.

Family D (Depository / Securities-account Infrastructure) is seeded as a fifth instrument
(`I-DEP`, `packages/db/src/seed/register.ts` / `survey-register-seed.json`) — its five questions
(D-Q1 through D-Q5) transcribed **verbatim** from the controlled document, with `scored: false`
and zero firm-specific items, matching every other institutional instrument. `REGISTER_ITEM_COUNT`
moved from 90 to 95; the one hardcoded test literal this broke (`drg-ops-enforcement.test.ts`'s
public-question count) was updated, not treated as a regression, per this phase's own instruction.

A NEW common controlled introduction paragraph (`renderInstitutionalIntro`,
`institution-family-service.ts`), parameterised by `{INSTITUTION_NAME}` /
`{INSTITUTIONAL_RELATIONSHIP}`, renders for every family including the three pre-existing ones.
This is deliberately separate from the EXISTING hardcoded institution references already baked
into I-SEC/I-NGX/I-CSCS's Q3/Q5 prose ("the Commission", "the Exchange", "the System") — those are
pre-existing approved content and are explicitly NOT retrofitted here.

`regulator_contacts` (Phase 9's provisional "all regulators" mailing-list stub) gets the same FK
treatment on its hardcoded `org_code` CHECK, without otherwise changing its behaviour — it is
deliberately NOT deep-rewired to source live from the new model in this phase (out of the tested
DoD scope; `org_code` stays a free-text label for backward compatibility).

**Superseded (2026-09-30) — `RegulatorsPage.tsx` is now live-wired.** It was left here as a
local-state mockup (a `SEED` array; nothing it recorded reached the database). An end-to-end run
found that every engagement was lost on reload and that Institutional Perspectives could therefore
never be generated. The page now reads and writes every role through `routes/regulators.ts`, and
submitting through an issued link confirms the role automatically
(`confirmEngagementForSubmittedRespondent`, inside the submission transaction).

### Item 2 — The edition-opening trigger

**What was actually found, not what the prompt assumed:** `survey_open_at` already existed
(initial schema) with a real setter (`openEditionFromDraft`, called by `markOpened`) — but
`markOpened` was never wired to any route or send (Phase 13's `invitations-service.ts` says so
explicitly). The edition genuinely had no way to open. This matches the prompt's premise
("currently-inert") in effect, even though the column and setter both technically existed.

**The interpretation taken (flagged per the prompt's own invitation to do so if reading the
source document differently):** rather than repurpose `survey_open_at` itself — which would
conflate "the study team's plan" with "the fact of when it actually happened" — a NEW column,
`editions.planned_open_at`, holds the configured launch instant. `survey_open_at` keeps its
existing meaning. `setSurveyOpenAt` (draft-only, `edition:manage`-gated) sets the plan;
`evaluateAutoOpen` is the lazy-evaluation trigger — no cron, matching this codebase's existing
precedent (Phase 13's reminder engine is a manually/read-triggered `run`, not a scheduler). It
runs on every `GET /editions/:id`: if the plan has passed and instruments are frozen, it opens
the edition (reusing `markOpened`); if the plan has passed and instruments are NOT frozen, it
returns a loud `problem: 'launch_date_passed_not_frozen'` — surfaced on `EditionPage.tsx` as a
`warnbox`, never a silent no-op. Verified in `institution-families.test.ts`.

### Item 5 — Industry SEI real derivation

Replaces the permanent `NOT_CALCULABLE` block (previously gated on an unapproved YAML parameter,
`industry_sei_min_firm_investor_observations`) with real derivation: `industrySeiState(pool,
editionId)` reads the edition's authoritative (signed-off) scoring run, takes every firm's own
`Firm_SEI` that cleared at least `DIRECTIONAL` sufficiency (`n >= SUPPRESS_BELOW`, via the
EXISTING generic `computeSufficiency()` — never a bespoke minimum-observations parameter
invented for this one metric), and means them. The COUNT of contributing firms is then run back
through the SAME `computeSufficiency()` ladder to decide the aggregate's own sufficiency — a
firm-count of 2 is `NOT_CALCULABLE` (a genuine data shortfall, resolvable by more raters or more
firms), a count of 30+ is `REPORTABLE`. No firm-level value is ever exposed alone.

This changes what NOT_CALCULABLE _means_: it used to be a permanent methodology block ("no
outreach resolves it"); it is now a data-shortfall / sign-off-pending state that DOES respond to
outreach and to scoring being signed off. The mission board's `conditionId: -1` card (still
`kind: 'methodology_block'`, still exempt from the "no action → off board" filter, since this
board has no bulk-outreach action for "sign off the scoring run") had its evidence/consequence
text rewritten accordingly — it no longer claims outreach is futile. Verified end-to-end against
a real signed-off run in `institution-families.test.ts` (exclusion of sub-floor firms, the
count-based aggregate gate, and the REPORTABLE case at 30+ firms).

### Item 6 — Institution-decline reopen action

`reopenDeclined` (`regulator-engagement-service.ts`) reopens a mistakenly-declined role, gated by
`access:regs` — Phase 8's existing permission, previously seeded but enforced nowhere in this
service until now. Deliberately **no maker-checker**: this corrects a routine mistake, not a
critical action. It resets status to `not_started` and clears the dead survey
link/lead-time/respondent (the same reset `saveContact`'s cancel-and-restart path already uses)
but **keeps the saved contact** — a design choice made during implementation: whoever declined is
still the right person to ask again, so the study team can re-issue a link immediately without
re-entering a name they already have. Verified in `regulator-engagement.test.ts`, including the
permission denial for a user without `access:regs`.

### Verification

`institution-families.test.ts` (new) plus updates across `regulator-engagement.test.ts`,
`mission-board.test.ts`, `mission-forecast.test.ts`, and `candidate-scoring-pure.test.ts` (the
last two updated for `IndustrySeiState`'s new shape — `industrySeiState` is no longer pure, so
its DB-backed cases moved out of the "pure" test file). Full suite green (351/351) against a
live Postgres; `pnpm turbo lint typecheck build` clean across all 8 packages; `pnpm audit`
clean.

## Phase 21 — Controlled Estate Reconciliation

Reconciles five separate, previously-tracked gaps against six controlled documents
(`DEC-012_ESTATE_RECONCILIATION.md`, `REOPEN_QUEUE.md`, the Engineering Handoff Readiness
Inventory, the Engineering Screen Stitching Guide, the SharePoint route map, and the
CIS_SCORING_ENGINEERING_BUILD_NOTE): a regression this session introduced and now reverses, a
scoring methodology version reconciliation, a real content-ingestion boundary replacing a bare
seed insert, a permanent regression test confirming a prior migration's completeness, and one
genuine unresolved contradiction between two controlled documents — flagged, not silently
resolved. The two source artefacts §2 cites by name —
`CIS_SCORING_METHODOLOGY_SPECIFICATION_v0.15.md` and `CIS_SCORING_CONFIG_CANDIDATE_v0.15.yaml`
— were never attached to this session; §2 says explicitly, item by item, what was implemented
on the build note's own detail and the phase prompt's own confirmation that no numeric weight
changed, and what was deliberately left untouched pending those two files.

### §1 — STOP-on-first-reminder: reverting this session's OWN regression (DEC-012)

Phase 13 shipped the correct design: a respondent's first scheduled reminder carries no STOP
language; every reminder after that does. A later pass in this session's own prior work (Phase
17/20) misread that design and made `carriesStop` unconditionally `true` — every reminder,
including the first, claimed to carry STOP language. `DEC-012_ESTATE_RECONCILIATION.md`
formally reaffirms Phase 13's original design against that misreading and records it as this
session's own error, not a pre-existing defect — and this section owns that plainly rather than
describing it as "a bug found."

The fix touches three points that all have to agree, because the earlier defect wasn't
contained to one of them:

- `nextDueReminder` (`reminder-timing-service.ts`) — the pure `carriesStop` computation, now
  `params.sentSteps.length > 0` (has this respondent received ANY reminder yet — robust against
  a cadence where step 1 is disabled and step 2 fires first for some respondent — rather than
  "is this configured step number 1").
- The SMS body (`reminder-content-service.ts`, `managed-content.ts` seed, and the Phase 17
  production migration) — "Reply STOP to stop reminders." was hardcoded directly into the
  template string. It's now a `{{stop_line}}` placeholder (mirroring the existing
  `{{progress_wording}}`/`{{recovery_url}}` convention), filled conditionally by a new
  `assembleReminderText(..., carriesStop)`.
- The email JSON template's `stop_link_text` field had no assembly function at all — a new
  `assembleReminderEmail(pool, respondentId, carriesStop)` conditionally nulls it.

Fixing only the pure function would have left the actual respondent-facing message content
unchanged and still wrong. `reminder-timing.test.ts` and `reminder-content.test.ts` were
updated to assert the corrected first-vs-subsequent behavior (previously asserting the wrong
thing), with two new tests verifying the fully-assembled SMS/email output directly rather than
only the `carriesStop` flag — closing the same "compiles fine but the actual output is wrong"
gap this session's own UI bug-hunt was about.

### §2 — Scoring methodology v0.14 → v0.15 reconciliation

Structural reconciliation only — no numeric weight, threshold or transform changed. Both the
build note's own changelog and the phase prompt's own §2.4 instruction agree on that point, and
it is the basis this section proceeds on in the absence of the actual v0.15 YAML/spec files.

**§2.1 — Three-state segment display (REPORTABLE / SHOWN_DIRECTIONALLY / SUPPRESSED).** A new
`SegmentDisplayState` type (`shared-types`) and `segmentDisplayState()` (`sufficiency-service.ts`)
collapse the existing five-state `computeSufficiency()` ladder — never a re-derived threshold —
onto the three-state model: REPORTABLE and SUPPRESSED map directly; DIRECTIONAL and BANDED both
collapse to SHOWN_DIRECTIONALLY (shown, not at full precision); NOT_CALCULABLE collapses to
SUPPRESSED.

_Strict non-reconstructability._ `evidence-pack-service.ts`'s `buildEvidencePack` gained a new
construction-time rejection, `SUPPRESSED_SEGMENT_RECONSTRUCTABLE`: a `FactInput` may now carry a
`segmentGroupId` (and one member per group an `isSegmentTotal` flag), and a group is rejected
the moment its lone SUPPRESSED member is back-out-able — every other sibling plus the total all
carry an exact point value (REPORTABLE or DIRECTIONAL; BANDED and SUPPRESSED never do), so
`total − Σ(other siblings) = the suppressed value` uniquely. Two or more SUPPRESSED siblings are
safe (one equation, multiple unknowns); a BANDED sibling is safe (no exact subtrahend). This is
a genuinely new rule — no prior version of this codebase checked for cross-segment
reconstruction — not a threshold retune. Covered in `evidence-pack.test.ts` (rejects the
reconstructable case, accepts it once the total is withheld, accepts two SUPPRESSED siblings)
and as a pure function, `isSegmentGroupReconstructable`, in `candidate-scoring-pure.test.ts`.

_Separated pooled-vs-standalone display._ `pooledHeadline()` (`candidate-scoring-service.ts`,
Phase 11) is unchanged in its pooling arithmetic — a segment still contributes to the headline
only once it clears its own `reportabilityFloor`, exactly as before. It now ALSO returns
`standaloneState: Record<string, SegmentDisplayState>`, each segment's own `segmentDisplayState`
computed independently of pooling eligibility. A segment can pool (clear its own, often lower,
pooling floor) while being SUPPRESSED standalone, and vice versa — the two were previously
conflated into a single floor read twice; they are now two genuinely separate fields on the same
return value. Test: `candidate-scoring-pure.test.ts`'s existing three-segment fixture, where
segment A pools at n=3 but is SUPPRESSED standalone (n=3 < the shared floor of 10).

_Not touched, on purpose._ The README's own previously-flagged `§8 threshold conflict` (the
retail-cut 10/30 thresholds in `firm-report-service.ts`'s `FirmReportCutState` vs. the dormant,
richer `governed_config` key `reporting.firm_investor_thresholds`) is NOT resolved here — §2.1
was scoped by the phase prompt to Phase 6 evidence-pack and Phase 11 pooling logic only,
`firm-report-service.ts` (Phase 6/14) is a separate surface, and reconciling it without the
actual v0.15 YAML would mean guessing which of the two documented floors the new model actually
intends. Left as the same open item it already was.

**§2.2 — Six-institution exclusion.** Confirmed already correct, not a code change. Exclusion
was never a hardcoded name list: `instrument_definitions.instrument_type IN ('institutional',
'regulator')` (four rows — `I-SEC`/`I-NGX`/`I-CSCS`/`I-DEP`) is a real, structurally-enforced
gate (`scored: false`; `getInstitutionalQuestionCodes`/`getInstitutionalInstrumentCodes`,
consumed by `evidence-pack-service.ts`'s `INSTITUTIONAL_AS_INDEX`/`FIRM_INSTITUTIONAL_CUT`
checks, and by every metric's own `config.questionIds` in `calculation-service.ts`'s
`runScoring`). Because NASD OTC, LCFE and FMDQ Securities Exchange share Family B's single
`I-NGX` instrument, and FMDQ Clear/FMDQ Depository share Family C/D's `I-CSCS`/`I-DEP` (Phase
19), all eight seeded institutions — the six named in this item plus CSCS's two roles — are
already covered by four instrument codes, with zero code change needed if a ninth institution of
an existing family registers later (the same rule Phase 19's Item 1 already established). New
regression coverage added to `institution-families.test.ts`: every non-survey instrument is
`scored: false`; the institutional/regulator instrument set is exactly
`I-CSCS, I-DEP, I-NGX, I-SEC`; and no active `metric_definitions` row's `config.questionIds`
ever names an institutional question code.

**§2.3 — Firm-level SEI independence.** Confirmed already correct, not a code change.
Firm-level `SEI` is computed by the ordinary, generic `runScoring()` pass
(`calculation-service.ts`) for every firm × every active metric — including `SEI`, one of the
five seeded `INDEX_CODES` — with zero dependency on `industrySeiState`. `industrySeiState()`
(`candidate-scoring-service.ts`) is a pure downstream reader: it loads already-computed
firm-level `SEI` rows via `listCalculatedResults` and aggregates; it never computes a firm's own
value. New test in `institution-families.test.ts` makes this explicit rather than implicit in
the existing aggregate-behavior tests: it reads a firm's own SEI result directly — including a
below-floor firm's SUPPRESSED row — BEFORE `industrySeiState` is ever called in the same test,
then confirms the aggregate reads the same rows back afterward.

**§2.4 — v0.14 → v0.15 citations.** Re-pointed where the cited substance is confirmed
unchanged: the `MethodologyStatus` doc comment (`shared-types`) citing the Phase 11 build
note's official-use hard gate now notes it was "reaffirmed unchanged in v0.15 (Phase 21 §2.4)".
`candidate-scoring-service.ts`'s module doc was reworded to state plainly that its numeric core
— every weight, transform and threshold — is still read from the v0.14 YAML
(`CIS_SCORING_CONFIG_CANDIDATE_v0.14.yaml`, `scoring-config.ts`), and that the v0.15
reconciliation changed structure, not numbers. **Deliberately NOT touched at the time**: the
YAML filename itself, and the seeded `metric_definitions`/candidate-config version number.
Renaming the file or bumping its version without the actual
`CIS_SCORING_CONFIG_CANDIDATE_v0.15.yaml` in hand would have misrepresented numeric behavior as
having moved to a new version when it had not. **This is now done — see the follow-up
immediately below**, where that exact file was supplied and the swap completed.

### Follow-up — v0.15 YAML supplied directly; §11 completeness; the new cross-segment rule

A follow-up round, after the actual `CIS_SCORING_CONFIG_CANDIDATE_v0.15.yaml` was supplied
directly (read from disk, not paraphrased) and the person running this session independently
read the prose `CIS_SCORING_METHODOLOGY_SPECIFICATION_v0.15.md` from SharePoint and confirmed
two things ahead of this work: no numeric weight changed (`Firm_DMI` and `Retail_ICI`'s weighted
components verified identical), and the prose spec's own §2.2 exclusion list text still names
only three institutions — validating, not undermining, this session's decision to key exclusion
off instrument type rather than off any literal name list (§2.2, above).

**The YAML swap, done.** `CIS_SCORING_CONFIG_CANDIDATE_v0.15.yaml` now sits alongside the v0.14
file in `packages/db/src/seed/` (the v0.14 file is kept, never deleted — it's the prior
authoritative version a signed-off v0.14 run's provenance still points to).
`scoring-config.ts`'s `CONFIG_FILENAME` now points to it; `seedCandidateScoringConfig` now seeds
`metric_definitions` as version 15. Diffing the two files directly (not from memory) confirms
the changes are exactly the ones this session's §2.1 work already anticipated structurally, and
nothing else: every transform, weight and threshold is byte-identical; only `decision_status.D1`
(now `PRODUCT_DECISION_APPLIED_PENDING_METHODOLOGY_VALIDATION`, with a candidate name that
explicitly says `_with_directional_standalone_display`), the `IEI`/`ICI` `headline.disclosure`
blocks (new `standalone_below_floor_display`), and the `privacy` block (restructured into
`standalone_segment_display.{shown_directionally,suppressed}`) changed. `methodologyVersionString()`
now reports `CIS-SCORE-2026@0.15`; the two DB-backed tests asserting the stamped
`methodologyVersion` literal were updated to match — this is a real, expected version bump, not
a fixed bug.

**§11 investor-side item-level completeness — built, not fixed.** The follow-up asked whether
Retail ICI, Local IEI, Foreign IEI and Foreign ICI's completeness logic already implements
§11's partial-allowance rules ("at least 2 of Q5–Q7", "at least 3 of 4 Q1 attributes") or was
silently too strict. The actual finding is a level below either: **no production code computes
per-investor-relationship eligibility for ANY of these six index-completeness rules at all** —
`pooledHeadline()` and `computeLikeForLike()` have always been pure aggregators taking
already-filtered `unitScores`/`unitScoresBySegment` as their input, and a repo-wide search
(including `apps/api`, `apps/admin`) turns up no caller of either function outside tests. So
this isn't a bug silently undercounting real evidence — the pipeline that would do the
undercounting doesn't exist yet. Rather than leave the gap open until that larger pipeline is
built, six pure, tested predicates were added now (`candidate-scoring-service.ts`, "§11
investor-side item-level completeness"), matching the spec's table exactly:

| Index                | Rule                                                 | Partial allowance? |
| -------------------- | ---------------------------------------------------- | ------------------ |
| `retailIeiEligible`  | S4-Q1, Q2, Q3 all required                           | No                 |
| `retailIciEligible`  | S4-Q4 required, **+ at least 2 of** Q5/Q6/Q7         | **Yes**            |
| `localIeiEligible`   | **at least 3 of 4** S5a-Q1 attributes, + S5a-Q2      | **Yes**            |
| `localIciEligible`   | S5a-Q5 and S5a-Q6 both required                      | No                 |
| `foreignIeiEligible` | S5b-Q1 + aggregated Q2 + aggregated Q3, all required | No                 |
| `foreignIciEligible` | aggregated Q4 + S5b-Q8, both required                | No                 |

Each reuses `isSubstantive` (never a re-derived missing-data check) and takes already-fetched
answer values — none reads the database or knows how a grid answer (S5a-Q1's four rows) is
actually stored; that remains the future pipeline's job. Tested exhaustively in
`candidate-scoring-pure.test.ts`, including the exact partial-allowance boundary cases (2-of-3
passes, 1-of-3 fails; 3-of-4 passes, 2-of-4 fails) and confirming the four full-completeness
rules tolerate no missing item. **Still open, and named as such rather than implied done**:
wiring these predicates to real per-respondent database reads and actually producing the
`unitScores`/aggregated-Q2-Q3-Q4 values `pooledHeadline` needs is a separate, larger, not-yet-built
pipeline — this follow-up closed the completeness-_rule_ gap, not the full investor-scoring
pipeline.

**The new `prohibit_cross_segment_comparison_unless_all_compared_segments_clear_floor` rule —
confirmed already implemented, not a gap.** v0.15's restructured `privacy.
standalone_segment_display.shown_directionally` block adds this rule for the first time in the
document. The codebase's one production cross-segment comparison
(`national-report-service.ts`'s `PUB_07_LOCAL_VS_FOREIGN`, `suppress_below_floor` rule) already
enforces exactly this: it publishes only once BOTH the local and foreign institutional segments
clear the REPORTABLE floor, and suppresses the comparison outright — not merely caveats it — the
moment either segment is only DIRECTIONAL/thin. A new test in `national-report.test.ts` makes
the v0.15 citation explicit and adds the "both segments thin" case the prior tests didn't cover.
No code change needed.

Verified: `@cis/domain` (29 files, 326 tests) and `@cis/db` (3 files, 25 tests, sequential) both
green against a live Postgres seeded from the real v0.15 config; `pnpm turbo build lint
typecheck` clean across all 8 packages.

### §3 — Survey content ingestion boundary (`SURVEY-REGISTER-EXPORT`)

`REOPEN_QUEUE.md` and the Engineering Handoff Readiness Inventory both record the same gap: no
machine-readable, controlled Survey Instruments Register export exists yet, and the seed content
reaches the database through a bare migration-style insert rather than a validated import path.
A new module, `packages/db/src/seed/register-ingestion.ts`, is that path: a versioned
`bindData(payload)`-shaped schema (`RegisterImportPayload` — `schemaVersion`, `source:
'interim_seed' | 'approved_export'`, a human-readable `sourceLabel`, and per-instrument question
items), a structural validator (`validateRegisterPayload` — non-empty schema version, a
recognized source, non-empty `sourceLabel`, per-item `question_id` uniqueness and non-empty
text, `kind`/`scope` enum membership, all failing loudly and specifically rather than on a bare
Postgres constraint), and the real loader (`importSurveyRegister`) that performs the same writes
the old direct-insert path did, but only after validation, tagging each instrument version's
`schema_snapshot` with the payload's `source`/`schemaVersion`/`sourceLabel` for provenance.

`register.ts`'s `seedSurveyRegister` is now a thin caller: it wraps today's known-good
`survey-register-seed.json` content as the INTERIM payload (`source: 'interim_seed'`) and feeds
it through this exact loader — the same content, never discarded, now flowing through a real
boundary instead of a direct insert. When the actual controlled Register export lands, binding
it is a data swap through the same `importSurveyRegister` call, never a code change. SV-010
(`survey-register.test.ts`) passes unchanged against content now loaded through the boundary —
proof the swap didn't alter what gets seeded. A new `register-ingestion.test.ts` (15 tests)
exercises the boundary directly: every validation rejection (bad `kind`, bad `scope`, duplicate
`question_id`, empty `text`/`schemaVersion`/`sourceLabel`, an unrecognized `source`, a
non-array/non-object shape), confirmation that a rejected payload touches the database not at
all, and that both `interim_seed` and `approved_export` provenance round-trip correctly onto the
stored `schema_snapshot`.

### §4 — Channel vocabulary sweep (DEC-010)

Confirmed already clean — no production change needed. `DEC-012_ESTATE_RECONCILIATION.md`
records a prior near-miss where a WhatsApp reference was found only by searching markup, missing
one still present in a code/copy string — the "search every layer, not just markup" lesson. A
new permanent regression test, `channel-vocabulary.test.ts`, recursively scans five source trees
(`apps/admin/src`, `apps/api/src`, `packages/domain/src`, `packages/db/src`, `packages/survey/src`)
across every `.ts`/`.tsx`/`.js`/`.json`/`.md`/`.yaml`/`.yml` file for case-insensitive
"whatsapp" outside a DEC-010-citing comment (including JSX `{/* */}` comments). The codebase was
already clean at every layer; this closes the gap by making that fact permanently checked rather
than re-verified by hand each time. UX-INS-001/002 (`FirmPortal.tsx`) were confirmed to
implement Text as their channel, per the same DEC-010 comment this test allowlists.

### §5 — ⚠️ Escalation, flagged and NOT resolved: six bespoke institutional instruments vs. one shared Family B instrument

A genuine contradiction between two controlled documents, left unresolved in code per this
phase's own explicit instruction not to pick a side:

- `CIS_Engineering_Screen_Stitching_Guide.md` describes "six bespoke instruments: SEC, NGX,
  CSCS, LCFE, NASD, FMDQ" — one instrument per named institution.
- Phase 19's own source document
  (`CIS_Institutional_Instrument_Families_Register_Extension`, v1.1) — which this codebase was
  actually built from — specifies Family B as ONE shared instrument (`I-NGX`) used by Nigerian
  Exchange Limited, NASD OTC Securities Exchange, Lagos Commodities and Futures Exchange AND
  FMDQ Securities Exchange Limited together, not four separate instruments. `institution-family-
service.ts`'s `FAMILY_META` maps family `'B'` to the single `instrumentCode: 'I-NGX'`, exactly
  as Phase 19 built it and as this session's own Phase 21 §2.2 work above continues to rely on
  structurally.

Phase 19's schema is left exactly as-is here — this section flags the tension for a product/
compliance decision, it does not adjudicate which controlled document is correct. Resolving it
either direction (splitting `I-NGX` into three/four bespoke instruments, or correcting the
Stitching Guide's prose) is out of scope for this phase and would itself need controlled-document
sign-off before any schema change.

**Separate, related, but distinct item — already fixed (§2.2/Item 5's `is_active`
enforcement).** LCFE, NASD OTC Securities Exchange, FMDQ Securities Exchange Limited, FMDQ Clear
and FMDQ Depository were seeded with `is_active` set but the column was never enforced anywhere
— `seedInstitutionEngagement` was reading `listInstitutionRoles` (every institution) rather than
an active-only view, so all eight institutions received engagement rows regardless of
registration status. Fixed: a new `listActiveInstitutionRoles(pool)` (`institutions.ts`, joins
`institution_roles` to `institutions` filtering `is_active = TRUE`) is now what
`seedInstitutionEngagement` reads, so the five institutions under CIS review — "not registered
and not in collection" per the Stitching Guide §8 — get no engagement row until CIS registers
them and someone flips the flag, a data change, never a code change. Verified in
`regulator-engagement.test.ts` (roster length 9 → 4 active; a new test asserts the five inactive
institutions are excluded by name). Per this phase's explicit instruction, the not-yet-controlled
scope-gate question for LCFE/NASD/FMDQ was deliberately NOT built.

### Verification

`pnpm --filter @cis/domain exec vitest run` (29 files, 319 tests) and
`pnpm --filter @cis/db exec vitest run --no-file-parallelism` (3 files, 25 tests — the db
package's test files race on Postgres's migration advisory lock when vitest parallelizes across
files, a pre-existing infra quirk unrelated to this phase; sequential run is fully green) both
pass against a live Postgres. `pnpm turbo build lint typecheck` clean across all 8 packages
(no new lint errors; the pre-existing `no-non-null-assertion` warnings are unchanged and
untouched by this phase). `pnpm audit` reports 3 pre-existing devDependency advisories
(`js-yaml` via `eslint`, `vitest`/`@vitest/mocker`) — none introduced by this phase (no
`package.json` or lockfile changed), all toolchain-only with no runtime/production exposure.

## Phase 22 — Investor-Unit Scoring Pipeline (Wiring, Not Inventing)

Closes the last piece of open scope from the v0.15 reconciliation: the previous session's
finding was that `pooledHeadline` and `computeLikeForLike` were correct, tested, PURE
functions with no production caller anywhere in the codebase, and that the six §11 eligibility
predicates were built and correct in isolation but never actually invoked against real answers.
This phase is assembly, not invention — every formula was already in the methodology spec
(§7/§8/§9/§10/§11/§13), every component piece already existed; the job was wiring them into
one real, database-backed pipeline and proving it with a test that exercises real seeded
`responses` rows through the real production entry point, `runCandidateScoring`.

### §2.1 — Relationship-level scores: one implementation, shared

`candidate-scoring-service.ts` gained the real relationship-level score functions
(`retailIeiRelationshipScore`, `retailIciRelationshipScore`, `localIeiRelationshipScore`,
`localIciRelationshipScore`, `foreignIeiUnitScore`, `foreignIciUnitScore`) plus the
firm-attribution-only foreign variants (`foreignIeiFirmSpecificObservation`,
`foreignIciFirmSpecificObservation`). None of these existed before this phase — the firm-side
combined-score logic Phase 11 built (`Firm_Investor_IEI_f`/`Firm_ICI_f`, §7.4/§8.4) had never
actually been implemented either; `firmSpecificInvestorAnswers` was a raw fetch with no
aggregation. So there was nothing to extract — instead, each relationship score was built ONCE
and is read by BOTH consumers from the same underlying grouped data: `retailInvestorObservations`
/`localInvestorObservations`/`foreignInvestorFirmObservations` return one array of
`{respondentId, firmId, iei, ici}` per instrument, re-aggregated two ways — by respondent for
the national unit score (`investorSegmentUnitScores`), by firm for the combined score
(`firmInvestorScores`) — never two separate computations. Each applies its §11 eligibility
predicate first (built in the prior follow-up); an ineligible relationship contributes to
neither aggregation, never imputed to neutral.

Foreign is deliberately NOT forced into the same relationship-then-collapse shape as
retail/local, per §7.3/§8.3's own explicit wording — it's computed directly per institution
(`foreignIeiUnitScore`/`foreignIciUnitScore`), aggregating firm-specific `Q2_i`/`Q3_i`/`Q4_i`
across every firm that institution rated BEFORE combining with the shared `Q1`/`Q8`. S5a-Q1 is
stored as one grid response (`{row: {Rating: value}}`) under a single question code, not four
separately-coded rows — `parseS5aQ1Attributes` extracts the four named attributes the "at least
3 of 4" rule needs directly from that JSON, rather than pretending each attribute has its own
DB-queryable code (it doesn't).

**Flagged framework interpretation, not invented silently**: the methodology names a national
`Foreign_IEI_unit_i`/`Foreign_ICI_unit_i` but never a "Foreign_IEI_relationship" for FIRM
attribution — only "firm-specific experience observations attributable to f, using only the
firm-specific components." `foreignIeiFirmSpecificObservation`/`foreignIciFirmSpecificObservation`
apply the same "mean of valid firm-specific components" shape every other relationship score
uses, for consistency. This is documented in code and here rather than silently assumed.

### §2.2 — Investor-unit collapse + §11 wiring; §2.3 — segment display state

`investorSegmentUnitScores(pool, editionId)` is principle 7's actual implementation
("multi-firm respondents receive one national respondent/institution weight after their firm
relationships are collapsed") — retail/local collapse to one unit per respondent (the mean of
that respondent's valid relationship scores across every firm they rated); foreign is already
one score per institution. Segment eligibility for pooling reuses Phase 21's existing
`segmentDisplayState`/`REPORTABLE_AT` — the methodology never defines a separate
pooling-specific floor number (§7.5: "only if it clears its reportability floor," then "let `E`
be the set of REPORTABLE segments" — the same word, the same threshold), so none was invented.

### §2.4/§2.5 — `pooledHeadline`'s real caller, with real persistence

`runInvestorPooling(pool, editionId, calculationRunId)` is the real caller `pooledHeadline` has
never had: pulls real unit scores, calls `pooledHeadline` for IEI and ICI, and persists each as
a genuine `calculated_results` row (`subject_type: 'market'`, `metric_code: 'IEI'`/`'ICI'`,
under whatever run it's given — always `TEST_UNAPPROVED` via that run). It is now a real stage
of `runCandidateScoring` itself, not a separate parallel entry point.

The §9 structured composition disclosure needed somewhere to live that a hand-built `reason`
string couldn't honestly provide — a new migration
(`20260918000000_phase22-investor-pooling.js`) adds a single nullable `composition JSONB`
column to `calculated_results`, populated ONLY for a pooled market IEI/ICI row, NULL for every
other result. A non-contributing segment (below-floor) is OMITTED from the array entirely —
`pooledHeadline`'s own `composition` field already only lists reportable segments; this only
persists that unchanged, never zeroing a segment that didn't contribute.

A below-floor segment is excluded from the headline and denominator regardless of whether its
OWN standalone state is `SHOWN_DIRECTIONALLY` or `SUPPRESSED` — that distinction only ever
governs standalone display (`pooledHeadline`'s independent `standaloneState` field, from Phase
21 §2.1), never pooling eligibility. Verified explicitly: a local segment at n=3 (`SUPPRESSED`)
and a foreign segment at n=15 (`SHOWN_DIRECTIONALLY`) are BOTH excluded from the pooled headline
identically, while their own standalone states remain genuinely different facts.

### §2.6 — `Firm_SEI_f`, now from a real `Firm_Investor_IEI_f`

`runCandidateScoring` gained a real per-firm SEI stage: for every firm with a valid `S1-Q11`
(`Firm_Expectation_f`) and a valid `Firm_Investor_IEI_f` (now real, from `firmInvestorScores` —
never a stub), it computes `Firm_SEI_f = 100 - abs(Firm_Expectation_f - Firm_Investor_IEI_f)`
and persists it as a firm-level `calculated_results` row, `REPORTABLE` unconditionally per §10
("private-report calculable... regardless of volume"). This is NOT the public Industry SEI
eligibility gate — `industrySeiState()` still reads from a DIFFERENT, separately-signed-off run
and its `industry_sei_min_firm_investor_observations` floor is still `PENDING_VALIDATOR`,
completely untouched, exactly as instructed.

### §2.7 — `computeLikeForLike`, wired the same way

`recordInvestorLikeForLike(pool, {metricCode, editionAId, editionBId, runAId, runBId})` builds
each edition's real `EditionSegmentEvidence` from data `runInvestorPooling` already persisted
for that edition's run (real unit scores, real reportable set, the real published headline read
back from `calculated_results`) — never a hand-built fixture — then calls the existing
`recordLikeForLikeComparison` exactly as before. The same "give the pure function a real
caller" fix applied to `pooledHeadline` above, applied to the second stranded function.

### No orphan pure functions remain from this phase's work

Every function Phase 22 touched has a real, database-backed caller reachable from
`runCandidateScoring`: the relationship scores are called by `retailInvestorObservations`/
`localInvestorObservations`/`foreignInvestorUnitScores`/`foreignInvestorFirmObservations`,
which are called by `investorSegmentUnitScores`/`firmInvestorScores`, which are called by
`runInvestorPooling` and the new firm-SEI stage, which are both called by `runCandidateScoring`
itself. `recordInvestorLikeForLike` calls `investorEditionSegmentEvidence` (which calls
`investorSegmentUnitScores`) then the existing `recordLikeForLikeComparison`. Nothing new added
here is a pure function awaiting a caller that doesn't exist.

### Explicit constraints respected, not re-litigated

- No shared market-level item (`S5b-Q1`/`S5b-Q8`) enters a firm-specific record —
  `foreignInvestorFirmObservations` reads only `S5b-Q2`/`Q3`/`Q4`, structurally, the same rule
  Phase 11 already enforced for `firmSpecificInvestorAnswers`.
- Institutional responses (SEC/NGX/CSCS/LCFE/NASD/FMDQ) never enter this pipeline — not via a
  runtime check, but by construction: `getInvestorInstrumentAnswers` is only ever called with
  `'S4'`/`'S5a'`/`'S5b'`, never an institutional instrument code.
- Every new `calculated_results` row this phase produces is still barred from official use —
  verified directly: `buildEvidencePack` against a `runCandidateScoring` run still throws
  `TEST_UNAPPROVED_RUN`, IEI/ICI/firm-SEI rows included, no exception introduced.
- No official imputation: every aggregation in this phase uses "mean of valid," excluding a
  missing/ineligible item rather than substituting a neutral value.

### The production entry point

`runCandidateScoring(pool, editionId)` (`candidate-scoring-service.ts`) — unchanged as the
single entry point, now with two additional real stages (firm-side SEI, investor-side IEI/ICI
pooling) alongside its existing DMI and Industry-SEI-NOT_CALCULABLE stages.
`recordInvestorLikeForLike` is the equivalent real entry point for the like-for-like
comparison, called separately (per the existing `recordLikeForLikeComparison` pattern) once two
signed runs exist to compare.

### Verification

A new `Phase 22` describe block in `candidate-scoring.test.ts` seeds 50 real respondents (32
retail — 30 fully eligible, one exactly at §11's 2-of-3 partial-allowance boundary, one
deliberately 1-of-3 and excluded from ICI only; 3 local, deliberately below `SUPPRESS_BELOW`;
15 foreign, deliberately between `SUPPRESS_BELOW` and `REPORTABLE_AT`) and calls the real
`runCandidateScoring` — not `pooledHeadline` in isolation — asserting the real, persisted
`calculated_results` row for IEI/ICI at `subject_type: 'market'`, its composition (retail only,
local/foreign omitted, never zeroed), the real firm-level SEI, and the `TEST_UNAPPROVED` gate.
A second test exercises `investorSegmentUnitScores`/`firmInvestorScores` directly to confirm
they expose the same real data. A third seeds two real editions with genuinely differing
reportable segment sets and calls `recordInvestorLikeForLike`, asserting the correct common
segment set, both recalculated values, and both original headlines preserved. Pure-function
coverage for the new relationship scores was added to `candidate-scoring-pure.test.ts`.
Verified: `@cis/domain` (29 files, 336 tests) and `@cis/db` (3 files, 25 tests, sequential)
green against a live Postgres; `pnpm turbo build lint typecheck` clean across all 8 packages;
`pnpm audit` unchanged (the same 3 pre-existing devDependency advisories, no `package.json` or
lockfile touched).

## UX-INS-003 shared-response resume — confirmed correct, no code change

A follow-up question asked specifically about `UX-INS-003` (the regulator survey — SEC/NGX/
CSCS/etc.): when a regulator's survey link (one recovery token per `(edition, institution,
family)` engagement, per Phase 12's `UX-OPS-007` issuance) is opened by a second person after a
first person entered answers but didn't submit, does the second opener see the first opener's
answers correctly resumed, or does reopening reset/overwrite them?

**Confirmed correct — no code change needed.** `getResumeByToken` (`journey-service.ts`) is a
plain lookup: `getRespondentByRecoveryToken` resolves the token to its one respondent row (minted
once, at issuance, by `issueSurveyLink`), then `getResume` returns that respondent's full,
unfiltered draft list. There is no per-open reset, no session/device fingerprint, no "second
opener wins" branch — every open of the same link resolves to the identical respondent id and
sees whatever is currently saved, because `upsertDraft` is keyed on
`(respondent_id, question_id, rated_firm_id)` and only ever updates one answer at a time,
never clearing the respondent's other drafts. This is a genuine single-shared-response design:
the token is a durable handle onto one response record, not a per-person key. The only things
that ever replace that respondent/token are explicit study-team actions in the admin app
(`saveContact`'s cancel-and-restart on a re-invited role, or `reopenDeclined`) — never a resume-GET.

New test: `regulator-engagement.test.ts`, "UX-INS-003 shared-response resume" — issues a real
survey link, resumes it once and saves a partial answer, resumes the SAME token a second time
("as if" a different person), and asserts the second resume returns the identical respondent id
with the first answer still present, unresetted.

**`UX-INS-001`/`UX-INS-002` were NOT touched and remain correctly independent per colleague.**
Those two journeys are structurally the opposite by design: `createReferral`/
`createColleagueInvite` (`journey-service.ts`) each insert a brand-new respondent row per
invite, and each colleague only gets their own recovery token once they individually register
contact — N colleagues means N respondents means N independent tokens, never a shared one. Their
own controlled artefacts are explicit that "colleagues answer independently and their responses
are not linked," which is what Phase 3 already built and is exactly right for individual
institutional investors giving personal opinions (as opposed to `UX-INS-003`'s one institutional
position). No code in either journey was changed.

Verified: `@cis/domain` full suite (29 files, 337 tests) and `@cis/db` (3 files, 25 tests,
sequential) green against a live Postgres; `pnpm turbo build lint typecheck` clean; `pnpm audit`
unchanged (no dependency change was needed for a test-only confirmation).

## Phase 23 — Post-Demo Findings: Two Confirmed Copy Bugs Fixed, Save/Freeze Flow Live-Reproduced

Three findings from a post-demo report. Two were real, confirmed bugs in Mission Board copy,
fixed directly. The third — a reported failure to save edition dates and to reflect an
instrument freeze — was not fixed, because it could not be reproduced: a genuinely fresh
environment (fresh clone state, fresh install, fresh migrate, fresh seed, fresh servers) drove
both flows end to end, in a real browser, against a real Postgres database, and both worked
correctly. Per the report's own instruction, this was not guessed at — see §2 below for exactly
how it was reproduced and what was checked.

### §1a — Internal-mechanics rationale leaking into user-facing copy (fixed)

`packages/domain/src/mission-board-service.ts`'s card builder wrote dependent Engine-2 findings
into a card's `consequence` array as `` `${e2.what} (folded in — not a separate card)` `` — a
description of the dedup MECHANISM (why this finding isn't its own card), not of the
CONSEQUENCE, and using an internal term ("folded in") a study-team user has no reason to know.
Fixed to `` `${e2.what} as a consequence of the same shortfall` `` — states the actual causal
relationship, says nothing about how the board decided to render it.

The same pattern, audited broadly rather than just at the quoted strings: `MissionBoardPage.tsx`
(the admin SPA's local-state Mission Board mockup — see its own file header; the real evaluator is
`mission-board-service.ts` above) carried three more instances in its example `consequence`
arrays, one in its "expected impact omitted" fallback text (`'Expected impact omitted — not
enough history yet to compute it (correct, not a bug)'`), and one in a rail-button tooltip
(`'Not built yet — honest stub'`). All rewritten to plain language with no reference to
implementation mechanics: no "folded in," no "not a separate card," no "correct, not a bug," no
"honest stub." `SEVERITY_LABEL`'s six rank labels were individually audited and are unaffected —
they're terse, factually accurate tier names (`'Statistical target threatened'` for rank 2
correctly describes every rank-2 condition, all of which are forecast-vs-floor shortfalls), not
leaked mechanism.

A repo-wide grep for the exact phrases plus "dedup(e/lication)" and "Engine 1/2" found two other,
unrelated surfaces using their own "not built"/stub language: `portalModel.ts`'s
`notBuiltForSeat` (Phase 4's orphaned-seat message, UX-FRM-004/005/006, already covered by its
own passing regression test) and `RespondentApp.tsx`'s firm-onboarding routing stub
(UX-FRM-001). Both are different, apparently-intentional, already-tested surfaces — not the
Mission Board drift this finding was about — and were left untouched.

### §1b — Stale "not built" rail labels for surfaces that are actually shipped (fixed)

`MissionBoardPage.tsx`'s `RAIL` array claimed three sections were not built:
`'Regulators (UX-OPS-007 — not built)'`, `'Monitoring (UX-OPS-003/004 — not built)'`, and
`'Dragnet analysis (UX-ADM-007 — not built)'`. All three are wrong — Regulators shipped in
Phase 12, Monitoring in Phase 13, and Dragnet analysis in Phase 16, each with its own real,
routed page (`RegulatorsPage`, `ResponsesPage`/`UnfinishedPage`, `DragnetPage`) already wired
into the top-level nav bar in `App.tsx`. This is a genuine regression: Mission Board's own
internal rail was never updated when those later phases landed. Fixed by setting `built: true`
and removing the parenthetical qualifier on all three, so the rail now reads `'Regulators'`,
`'Monitoring'`, `'Dragnet analysis'` like the other three (already-correct) entries. No new
click-through navigation was added — `MissionBoardPage` has no navigation wiring to any sibling
page for any rail entry, built or not (it's a self-contained mockup, matching the same
deliberate-scope pattern as `RegulatorsPage`'s Phase 19 `SEED` array), and adding it selectively
for just these three would create an inconsistent asymmetry the report didn't ask for. The rest
of the rail's definitions were audited and carry no other stale claim.

### §1c — Regression test

New `apps/admin/src/pages/MissionBoardPage.test.ts` (`CARDS`/`SEVERITY_LABEL`/`RAIL` exported for
testability): asserts no card field, severity label, or rail label matches a set of
internal-mechanics patterns (`folded in`, `not a separate card`, `correct, not a bug`,
`honest stub`, `dedup(e/lication)`, `Engine [12]` — by pattern, so a differently-worded re-leak of
the same class is still caught, not just the exact original strings), and that every `built: true`
rail entry's label carries no "not built" qualifier, with Regulators/Monitoring/Dragnet analysis
explicitly checked.

### §2 — Save/freeze flow: reproduced fresh, live, twice — no bug found

The report described planned-launch/closing-date saves and instrument freeze/approve not taking
effect. Both `EditionPage.tsx`→`client.setOpeningDate`/`setClosingDate` and
`SurveysPage.tsx`→`client.requestFreeze`/`decideFreeze` read as correctly wired from source
inspection alone, which made three explanations equally plausible: a stale demo environment, a
genuine runtime bug invisible to static review (the same class as a prior timezone bug), or
something environment-specific. Rather than guess, it was reproduced for real:

1. **Genuinely fresh state.** This session's container started with no `node_modules` anywhere
   and no Postgres roles or databases beyond the OS defaults — confirmed fresh, not reused. Ran
   `pnpm install`, `pnpm turbo build`, created the `cis` role and `cis_dev`/`cis_test` databases,
   ran `pnpm --filter @cis/db migrate:up` against `cis_dev` (19 migrations, clean), seeded with
   `pnpm --filter @cis/api seed` (real `seedReferenceData`, not a fixture), and started the API
   and admin dev servers as fresh processes (not reused from any prior state).
2. **Edition dates, in a real browser (Playwright, Chromium).** Logged in as the seeded maker
   user, on the Edition screen (the app's default landing tab). Set the planned launch date,
   clicked Save — a real `PATCH /editions/:id/opening-date` fired and returned 200. Set the
   closing date, clicked Save — a real `PATCH /editions/:id/closing-date` fired and returned 200.
   Reloaded the page (a full SPA reload, not a soft navigation): both dates were still shown,
   correctly. Queried `cis_dev.editions` directly: `planned_open_at` and `survey_close_at` had
   actually changed to the saved values.
3. **Instrument freeze, across two different logged-in users.** From the Surveys screen, requested
   a freeze as the maker (`POST .../freeze/request`, 201, with a reason). Logged in as a
   genuinely different user (the seeded checker) in a second browser context, opened "Review the
   request," and approved (`POST .../freeze/:id/decide`, 200, `{status: 'approved', frozen:
true}`). The frozen banner, the per-instrument "Frozen" pills, and the "FROZEN" eyebrow all
   appeared correctly for the approving user immediately, and for the requesting user after a
   fresh reload and re-navigation to Surveys. Queried the database directly: all ten
   `instrument_definition_versions` rows had `is_frozen = true`, and the `critical_actions` row
   showed `status = 'approved'` with `requested_by` and `approved_by` genuinely different users.

Everything worked, both times, at every layer checked (UI, network request/response, and the
underlying database row). **Conclusion: the reported failure was stale or misconfigured demo
infrastructure, not a code defect.** No fix was made — per the report's own instruction, the
freeze-transition UI was not touched or rebuilt; it was already correct.

**Exact, minimal checklist for a reliable fresh demo, going forward:**

```bash
git pull                                            # 1. latest code
pnpm install                                        # 2. reinstall — a stale node_modules or
                                                     #    lockfile mismatch is the single most
                                                     #    likely cause of a demo behaving
                                                     #    differently from what the code says
pnpm turbo build                                    # 3. rebuild every workspace package's dist/
pnpm --filter @cis/db migrate:up                    # 4. re-migrate — a demo DB on an old schema
                                                     #    version will not show new-phase behaviour
pnpm --filter @cis/api seed                         # 5. re-seed (idempotent — safe to re-run;
                                                     #    skips if the 2026 edition already exists)
# 6. restart BOTH servers as fresh processes — do not reuse a process from a previous demo,
#    especially one started before step 2–4 above:
pnpm --filter @cis/api dev      # in one terminal
pnpm --filter @cis/admin dev    # in another
```

### §2 (continued) — the coverage gap this surfaced, closed

The save/freeze flow itself needed no fix, but the reproduction surfaced a real, pre-existing gap:
`apps/api` had zero tests of any kind. Every domain rule these routes call
(`setSurveyOpenAt`/`setClosingDate`/`requestFreeze`/`decideFreeze`) is already well covered in
`packages/domain/tests/edition-service.test.ts` and `instrument-freeze.test.ts`, but nothing
exercised the HTTP layer itself — request parsing, JWT auth wiring, response serialization —
which is exactly the layer a stale-environment class of report tends to implicate, and exactly
the layer this session's reproduction had to fall back to manual browser automation to check
because no automated test covered it.

New `apps/api/tests/edition-instrument-save-flow.test.ts`, added to the existing DB-backed
`integration` Vitest project (`apps/api/tests/**/*.test.ts` added to the `projects` in `vitest.config.ts`) rather
than as new test infrastructure: calls the real `buildServer()` Fastify app via `app.inject`
(no listening socket needed) against a real Postgres database. Mirrors the manual reproduction
exactly — logs in over `/auth/login`, `PATCH`es both dates, then issues a fresh `GET` (the
save-then-reload path) and a direct row query to confirm persistence past the API's own echo;
requests a freeze as one user, approves as a different user, and confirms both the API's
`frozen: true` response and the underlying `instrument_definition_versions`/`critical_actions`
rows. A future regression in this exact HTTP path — not just the domain logic underneath it —
now has a test that would catch it.

### Verification

Fresh Postgres role/databases created, `pnpm --filter @cis/db migrate:up` and
`pnpm --filter @cis/api seed` run clean against `cis_dev`; live browser reproduction (Playwright/
Chromium) of both the date-save and freeze/approve flows, cross-checked against direct database
queries, found no defect. Full suite: `pnpm test` — **39 files, 410 tests, all green** (including
the new `MissionBoardPage.test.ts` and `apps/api/tests/edition-instrument-save-flow.test.ts`)
against a live Postgres. `pnpm lint`, `pnpm typecheck`, and `pnpm turbo build` all clean.
`pnpm audit` unchanged — the same pre-existing devDependency advisories as every prior phase, no
`package.json` or lockfile touched.

## Phase 23 correction — Brief-Derived Copy Is a Systemic Pattern, Not Five Phrases

Phase 23 §1a/§1b fixed the exact phrases a bug report named. That was too narrow: the underlying
defect is that `OPS_MISSION_BOARD_BUILD_BRIEF.md`'s worked examples, severity-table vocabulary,
and remediation-table reasoning had leaked into user-facing copy wholesale — fixing five named
phrases left the same class of defect sitting in plain sight elsewhere on the same screen. This
correction fixes those remaining instances and, more importantly, replaces the phrase-list method
with a durable one: **search by source, not by phrase.** A build brief exists to make engineering's
reasoning legible to engineers — its worked examples, severity taxonomy, and audience-selection
rationale are for a build team, never for the person reading a finished screen. Anything in a brief
that reads like a sentence a user would see is an illustration, not a string; any number in a brief
is a worked example, not a value to hardcode. The correct standing rule, confirmed directly against
the current live `UX-OPS-001` v4.9 artefact (whose functional JavaScript is `var WORK = {}` /
`var RULES = []` — genuinely empty, with every card field supplied by `bindData(payload)` at
runtime): **the artefact and the brief both carry no literal product copy. Production copy is
always written fresh, describing a real computed value in plain language — never adapted from
either.**

### What was still wrong, and why the previous fix missed it

`317254c` fixed the phrases the report quoted, but two of the brief's own worked examples were
still present verbatim, unrelated to those five phrases:

- `'National retail floor missed by 333'` — §4A's illustrative shortfall number — was hardcoded in
  `MissionBoardPage.tsx`'s `CARDS` array as though it were a real value.
- `2: 'Statistical target threatened'` — §5's own severity-table label for rank 2 — was sitting
  unchanged in `SEVERITY_LABEL`, because the previous audit judged it "stylistically consistent"
  without checking where the wording actually came from.

And the §1a fix itself, while an improvement, was incomplete in kind: rewriting
`` `${e2.what} (folded in — not a separate card)` `` to
`` `${e2.what} as a consequence of the same shortfall` `` changed the words but kept the same
shape — engineering still explaining, via an appended clause, _why the system organized this
information the way it did_, rather than simply stating the consequence. Under a "Consequence"
heading, the fact alone (`e2.what`) already reads correctly; no wrapper clause was ever needed.

### The actual defect: `MissionBoardPage.tsx` was never connected to the real evaluator

The deepest issue, and the reason the phrase-by-phrase fix couldn't fully succeed: `evaluateBoard`
(`mission-board-service.ts`) is a real, tested, live evaluator, reachable over a real route
(`GET /editions/:id/mission-board`, `apps/api/src/routes/mission-board.ts`) — but nothing in
`apps/admin` ever called it. `App.tsx` rendered `<MissionBoardPage />` with **no props at all**,
and the page held its own permanently-static `CARDS` array. Every real, logged-in user who opened
"Mission board" — in production, today, regardless of the edition's actual state — saw the same
fabricated example forever. This is not a dev-only fixture (`CARDS`'s own comment called it
"Example board state," which invited exactly that wrong assumption without ever being checked):
it was the literal, unconditional, production render path for a core screen. As long as this was
true, no amount of phrase-editing inside `CARDS` could produce "genuine computed values" — a
static array cannot compute anything. The fix had to be structural, not lexical.

`MissionBoardPage.tsx` now takes `{client, editionId}` (the same pattern every other wired admin
page already uses — `EditionPage`, `SurveysPage`), fetches the real board via a new
`client.getMissionBoard(id)` (added to `AdminClient`, mirroring the existing method pattern; new
`MissionCard`/`MissionBoardResponse` types in `api/types.ts` mirror `@cis/shared-types`'s real
`MissionCard`), and renders exactly what `evaluateBoard` returns — real evidence, real consequence
text, real recommended actions, real (or genuinely omitted) expected impact. The fake local
"Edition phase" toggle buttons — which let anyone click through four fabricated phases regardless
of the edition's actual state — are gone; the rail's phase-awareness now reads the real `phase` the
API returns alongside the cards. `RAIL` (navigation metadata — which admin sections exist and
when they're relevant) stays static, same as before, because it's genuinely UI structure, not
brief-illustrative content, and isn't materially different from Phase 23's already-correct fix to
it.

Verified live, not just by test: with the API and admin dev servers running against a freshly
seeded `cis_dev`, the Mission Board screen now shows real computed evidence (`"Forecast
firm-attributable 0 of 80 required"` — the seed's actual firm floor, actual zero responses) and a
freshly-worded severity label (`"A planned report is at risk"`), with the rail correctly greying
out Monitoring/Results/Dragnet analysis because the seeded edition is genuinely in `before_launch`
phase — not because they're unbuilt.

### Severity labels, rewritten fresh — not paraphrased

All six `SEVERITY_LABEL` entries were rewritten, not just rank 2 — the whole table traces to the
same brief section (§5), so the whole table was suspect, not only the one instance a report
happened to quote. Same six ranks, same order (1 most consequential), independently composed:

| Rank | Before (brief §5's own wording)   | After (written fresh for this screen) |
| ---- | --------------------------------- | ------------------------------------- |
| 1    | Cannot deliver the promised study | Puts the whole study at risk          |
| 2    | Statistical target threatened     | A sample target will be missed        |
| 3    | Report dependency threatened      | A planned report is at risk           |
| 4    | Severe funnel failure             | Many firms are stuck in the funnel    |
| 5    | Representation risk               | A required voice may go missing       |
| 6    | Routine operational follow-up     | Needs a routine follow-up             |

### Remediation-cohort labels: the same "why we chose this route" leak, in §8B's table

Applying the same test (does this explain real-world state a user needs, or the system's own
internal reasoning?) to `remediationForCohort` — the source of every card's "Recommended action"
text — found three more instances of the identical em-dash-appended-rationale pattern already
confirmed in §1a, this time from §8B's remediation table:

- `'Bulk nudge — knowable without a client list'` → `'Bulk nudge'`
- `'Message all participating firms — the relevant cohort cannot be identified'` →
  `'Message all participating firms'`
- `'Export the bounced addresses for CIS — nowhere to bulk-send'` →
  `'Export the bounced addresses for CIS'`

Each dropped clause explained an internal audience-targeting/data-modeling limitation ("knowable,"
"cannot be identified," "nowhere to bulk-send" are all properties of Phase 9's targeting system,
not of the real world) — the exact same shape as `'(folded in — not a separate card)'`, just in a
different table. By contrast, `mission-forecast.ts`'s four funnel-diagnosis labels (`'Invited but
not claimed — wrong person, dead address, or nobody acted.'` and its three siblings, §17's
funnel-diagnosis example) were deliberately left untouched: they explain plausible _real-world_
reasons a firm might be stuck, which is exactly what an operator needs to act — not how the
software is built. Not every string that traces to a brief section is a defect; the test is what
kind of thing it explains, not where it originated.

### Dragnet rail label — confirmed, not just Regulators/Monitoring

Re-verified directly against the current file: `RAIL`'s `dragnet` entry reads `built: true`,
`label: 'Dragnet analysis'` — no "not built" qualifier. This was already corrected in `317254c`
alongside Regulators and Monitoring; nothing further was needed here.

### A durable test, not a bigger phrase list

`packages/domain/tests/mission-board.test.ts` gained a new describe block asserting, by pattern
rather than by exact string: no `CONDITIONS[].what`, no `remediationForCohort(...).label` for any
of the eight cohorts, and no field of a real, live-evaluated board's cards matches the confirmed
jargon-shape patterns (`folded in`, `not a separate card`, `dedup`, `engine [12]`, `knowable
without`, `cannot be identified`, `nowhere to (bulk-)send`, an em-dash followed by a
system/audience/cohort/targeting-reasoning clause, and — a direct regression guard — the exact
brief-table phrase `'Statistical target threatened'`). This runs against the real evaluator, not a
fixture, so it catches a reintroduction regardless of which card produces it.
`apps/admin/src/pages/MissionBoardPage.test.ts` was updated to match: the old `CARDS`-specific
test is gone (there's no longer a static `CARDS` export to test — the page fetches real data), and
it now guards the two exports that remain genuinely static: `SEVERITY_LABEL` and `RAIL`. The
"illustrative number hardcoded as if real" failure mode (`333`) has no equivalent test, deliberately:
it doesn't need a numeric blocklist, because the structural fix (the page can no longer render
anything but a real computed value) eliminates the failure mode by construction, not by pattern-
matching a number that could legitimately recur as a real, coincidental shortfall in a different
scenario.

### Verification

Full suite: `pnpm test` — **39 files, 412 tests, all green** against a live Postgres (up from 410:
+3 new domain jargon-regression tests, +4/−5 in the rewritten admin page test). `pnpm lint`,
`pnpm typecheck`, and `pnpm turbo build` all clean. `pnpm audit` unchanged. Live-verified in a real
browser (Playwright/Chromium) against a freshly seeded `cis_dev`: the Mission Board screen renders
real evidence, real consequence text, and the correct phase-aware rail state — screenshotted for
the record, not just asserted in a test.

**The standing rule for any future screen built from a brief:** a build brief explains reasoning
and gives worked examples so engineering understands the rules. It never supplies copy. Anything
in a brief that reads like a sentence a user would see is an illustration, not a string; any number
in a brief is a worked example, not a value to hardcode. When an artefact exists, check it
directly before assuming it's a copy source — this artefact carries no literal text at all, every
field arrives via `bindData` at runtime, which means the standing rule is not "copy text from the
artefact" either. Production copy is written fresh, in plain language, describing a real computed
value.

## Design Reconciliation Audit — Batch 1 of 7

Every surface was originally built against a specific artefact version; the controlled design
estate has since moved on via source-hygiene ("Clean Artefact Gate") passes. This audit works
through the estate five surfaces at a time, verifying each artefact's own `product_behaviour_changed`
claim against its itemized changelog rather than trusting the summary field, and cross-checking for
defect classes already found on this programme. Batch 1: `UX-ADM-001` (Edition, v4.7), `UX-ADM-002`
(Surveys, v1.6), `UX-ADM-004` (Scoring, v1.8), `UX-ADM-005` (National report, v1.9), `UX-ADM-006`
(Firm reports, v1.9).

### UX-ADM-001 (Edition) — outcome (a), confirmed no functional change

`functional_baseline_version: "v4.1"`; `source_purity_delta.product_behaviour_changed: false` from
v4.2 through v4.7. Read every itemized `changes_from_v4_0`/`changes_from_v4_2` entry directly: the
real functional history (single-date model, opening-is-observed-not-declared, sample floors
locked at open) all predates v4.1 and is already built (`EditionPage.tsx`, verified against this
session's own live fresh-environment reproduction of the save flow). v4.2→v4.7 is exclusively
review-harness removal and `bindData(payload)` externalization. No code change.

### UX-ADM-002 (Surveys) — outcome (a), confirmed no functional change

`functional_baseline_version: "v1.2"`. The one real, itemized functional correction in this
artefact's history — `changes_from_v1_1`: "the prose said firm instruments while the list beneath
it named S4-A1, S5a-A1 and S5b-A1 — they span the firm and investor instruments both" — is already
correctly implemented: `SurveysPage.tsx`'s copy reads "folded into the natural flow of the scored
**firm and investor** instruments," not "firm instruments" alone. `changes_from_clean_artefact_migration`
confirms no further behaviour change through v1.6. One minor, non-functional cosmetic difference
noted, not fixed (out of this audit's functional scope): the artefact's pill reads "Dragnet
product-internal," the built page reads "Dragnet internal" — same meaning, different wording, no
behavioural consequence.

### UX-ADM-004/005/006 (Scoring, National report, Firm reports) — outcome (a) on version delta, but a much bigger issue found underneath

All three artefacts confirm `product_behaviour_changed: false` from their stated functional
baselines (v1.2, v1.5, v1.3 respectively) through their current versions, and the itemized
changelogs agree — the real functional history (scores shown before sign-off, the ten-sections
rebuild, atomic-per-report release) all predates each baseline and was already correctly built.
**On the version-reconciliation question alone, all three are outcome (a).**

But item 4 of this audit's own method — cross-check for a hardcoded fixture where the artefact
expects live data — caught something version-reconciliation doesn't test for: **all three pages
were built the exact same way Mission Board was before the post-demo-findings fix** (`1432282`,
above): a "Self-contained functional surface (local state)" mockup with a manual demo
state-toggle button row, `<Page />` rendered with zero props from `App.tsx`, never calling the
real, tested, already-routed backend. Every artefact here also declares
`product_persists_declared: true` — the real product was always expected to persist, not simulate.
A targeted grep across every file in `apps/admin/src/pages` for the same shape (the exact phrase
"Self-contained functional surface (local state)", plus a manual `STATES`/`DRAGNET_STATES` toggle
row, plus zero props in `App.tsx`) found **one further, not-yet-fixed instance beyond these
three: `InvitationsPage.tsx` (UX-OPS-002)** — same header phrasing, same zero-prop call site, and
`apps/api/src/routes/invitations.ts` already exposes a full set of real GET endpoints it never
calls. `InvitationsPage` is not part of this batch's five artefacts and is a substantially larger
surface (messages/templates/requests, batches, file-upload validation, an audience wizard) — it is
flagged here for a dedicated pass, not fixed in this one. Two OTHER zero-prop pages
(`RegulatorsPage.tsx`, `PeopleAccessPage.tsx`/`ResponsesPage.tsx`/`UnfinishedPage.tsx`/`FirmResultsPage.tsx`)
were checked and are a different case: `RegulatorsPage.tsx` explicitly and honestly documents
itself as "a DELIBERATE scope decision (documented in the README), not yet wired to the live
per-role API" — an acknowledged, previously-reviewed gap, not a hidden one — and the other four use
different, non-misleading header language ("mirrors that," never "self-contained"). Only the four
using the exact misleading phrasing were in scope for this fix.

**Fixed, live-wired exactly like Mission Board — `ScoresSignoffPage.tsx`, `NationalReportPage.tsx`,
`FirmReportsPage.tsx`:**

- All three now take `{client, editionId}` (`ScoresSignoffPage`/`NationalReportPage` also take
  `viewer`, for maker-checker identity) instead of zero props, calling real endpoints in
  `scoring.ts`/`reporting.ts` through new `AdminClient` methods and matching types in `api/types.ts`.
- **Scoring**: real run history, real per-index scores/populations/floor status
  (`getScoreView`), real structured sign-off request/approve. Live-verified: triggered a real
  scoring run, requested sign-off as one seeded user, approved as a different seeded user — the DB
  row shows `state: 'signed_off'`, `requested_by ≠ approved_by`.
- **National report**: real ten-section sufficiency evaluation (`evaluateSection`), draft-opened
  tracking, the four real approval preconditions, request/approve. Live-verified against the
  fresh seed (no institutional data): correctly evaluated 9 publishable / 1 suppressed
  (`PUB_10_INSTITUTIONAL_PERSPECTIVES`, 0 of 3 regulators engaged) — real business logic, not
  fabricated numbers.
- **Firm reports**: real generation, per-firm approval, atomic-per-report release, and the
  "zero participating firms is an outcome, not an empty list" state the artefact explicitly
  requires — live-verified against the fresh seed (genuinely zero participating firms): the page
  now says so honestly ("There are no reports to release... this is not a suppression and nothing
  is being withheld") instead of looking identical to "generation never attempted."
- One small, necessary backend addition, not a new feature: `national_reports` had no
  lookup-by-edition, only by-report-id — a fresh page load had no way to discover the current
  report. Added `getLatestNationalReportForEdition` (`packages/db`) and
  `GET /editions/:id/national-report` (thin plumbing over the already-tested domain layer,
  mirroring `getFirmReports`' existing by-edition pattern), with a new HTTP-level test
  (`apps/api/tests/national-report-lookup.test.ts`) and two new domain-level tests
  (`packages/domain/tests/national-report.test.ts`).

**Real gaps found while wiring, documented honestly rather than fabricated or silently worked
around:**

- `ScoringSignoffState` has no `'rejected'` value, and there is no
  `POST /scoring-signoffs/:id/reject` route — the old mockup's "Reject" button was never backed by
  a real capability at any layer, not even the domain model. The live-wired review view offers
  only what's real: approve, or leave pending.
- `regenerateFirmReport` exists and is tested in `firm-report-service.ts`, but has no route — a
  held/failed firm report cannot actually be retried from the admin app yet. Shown honestly (the
  held state and its reason are real and visible); no fake retry button was added.
- **The significant one**: `national-report-service.ts`'s sentence-level adversarial review
  (`saveNationalDraft`, `runChecker`, `runAdversaryHealth`, `disposeFinding`) is real, tested
  domain logic — but nothing anywhere in this codebase generates draft report sentences from real
  scores (no LLM call, no template engine, no generator of any kind). The old mockup's `DRAFT`
  array was entirely invented example prose standing in for a capability that doesn't exist. Since
  `nationalApprovalPreconditions` requires `checkerHealthy` (which requires a persisted
  `adversary_health` row, which requires `runAdversaryHealth` to have run at all), **no national
  report can be approved through the real system today** until this is resolved. This is flagged
  here, not resolved unilaterally, per this programme's standing escalation discipline — it needs a
  product decision (build a real AI-generation pipeline for the ten sections; or define a
  human-drafts-the-text-directly workflow, which the domain layer's own neutral design already
  supports — `saveNationalDraft` "persists a generated draft; it computes nothing," and doesn't
  care whether the sentences came from a model or a person), not a UI-only fix.

### Running list of open items needing a decision (not resolved here)

1. **National report approval is currently unreachable end-to-end** (above) — needs a product
   decision on how draft sentences get produced before the adversarial-checker gate can ever pass.
2. **`InvitationsPage.tsx` (UX-OPS-002)** — confirmed same "local-state mockup, never calls its own
   real routes" defect as Mission Board/ADM-004/005/006, not yet fixed. Real routes already exist
   (`apps/api/src/routes/invitations.ts`). Needs a dedicated pass — this surface is large
   (messages/templates/requests, batches, file-upload validation, an audience wizard).
3. **Scoring sign-off has no reject path** — `ScoringSignoffState` and the API both lack one. Worth
   a product decision on whether a reject capability should exist here (the national-report and
   edition-lock flows both have one; scoring sign-off doesn't).
4. **Firm-report regeneration has no route** — `regenerateFirmReport` is real and tested but
   unreachable from the admin app. Small, mechanical fix once prioritized.

### Verification

Full suite: `pnpm test` — **40 files, 415 tests, all green** (up from 39/412: +2 domain tests for
`getLatestNationalReportForEdition`, +1 new HTTP-level test file) against a live Postgres.
`pnpm lint`, `pnpm typecheck`, `pnpm turbo build` all clean. `pnpm audit` unchanged — the same
pre-existing devDependency advisories as every prior phase. Live-verified in a real browser
(Playwright/Chromium) against a freshly seeded and locked edition: triggered a real scoring run,
completed a real two-user sign-off, generated a real national report with correct sufficiency
evaluation, and confirmed the honest "zero participating firms" firm-reports state — screenshotted
for the record at every step, not just asserted in a test.

## InvitationsPage — Live Wiring (fourth and largest instance of the same defect class)

The fourth instance of the "self-contained local state" mockup defect — Mission Board, then
`UX-ADM-004/005/006` — confirmed for `InvitationsPage.tsx` (UX-OPS-002) in the last batch's
targeted grep, and given its own dedicated pass here as planned, since it's a substantially
larger surface than the previous three. Phase 9 built the full invitations engine —
`invitations-service.ts` — in advance; this was purely a wiring fix, not a rebuild.

### §1 — Inventory: every piece checked independently

| Piece                       | Before                                                              | After                                                                                               |
| --------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Audience selection & counts | Hardcoded `AUDIENCES` array (fixed numbers like `n: 249`)           | Live `listAudiences` — real query against Phase 4 firm/seat state and Phase 3 contact-consent       |
| Templates (list/edit/save)  | `SEED_TEMPLATES`, edits discarded on close                          | Real CRUD (`listMessageTemplates`/`saveMessageTemplate`), real `{{code}}` gate enforced server-side |
| Send wizard                 | `onDone` just closed the wizard — nothing was ever sent             | Real `sendInvitationBatch`, real per-template dedup                                                 |
| File-upload validation      | Descriptive text only — no file input existed at all                | Real four-check validation (`validateUploadFile`), live file input                                  |
| Batch / delivery report     | `SEED_BATCHES`, fixed numbers                                       | Real `listInvitationBatches` + `getInvitationBatchReport` per batch                                 |
| Bounce listing              | A "List the addresses that bounced" button with no `onClick` at all | Real listing — see the found gap below                                                              |
| Access-request queue        | `SEED_REQUESTS`, resolved state never left the browser              | Real `listInvitationRequests` / `resolveInvitationRequest`                                          |

Every piece was mocked; none were already real. `InvitationsPage.tsx` now takes `{client,
editionId}` (previously zero props, per the last batch's grep) and calls the real backend for
all seven.

### §2 — Two real backend gaps found while wiring, both fixed (not just noted)

1. **`resolveFirmNameToOrg` existed, untested, and was never called from anywhere.** Without it,
   an uploaded CSV row had no way to carry a real `organizationId`, so the fourth file-validation
   check (a firm already sent this template) could never fire for an upload — only for a
   firm-audience send. Added `resolveFirmNamesToOrgs` (`packages/domain/src/invitations-service.ts`)
   — the same exact, case-insensitive match, batched to fetch the register once instead of once
   per row — plus `POST /editions/:id/invitations/resolve-firm-names`, wired into the upload
   handler before validation. This is _not_ a fifth validation check and does not block a row on
   its own; it only supplies the id the already-existing fourth check needs. Live-verified: a CSV
   row naming an already-invited firm is now correctly flagged `already_sent`.
2. **`listBouncedRecipients` existed at the `@cis/db` layer only** — its own doc comment already
   said "for the 'list the addresses that bounced' action" — with no domain-service wrapper and no
   route. Added `getBouncedRecipients` (thin pass-through, matching the existing
   `listMessageTemplates`/`getBatches` pattern) and `GET /invitations/batches/:batchId/bounced`,
   wired into the batch report view. Live-verified: simulated a real Zeptomail bounce webhook
   event and confirmed the exact bounced address is listed, with no resend action anywhere.

Both gaps were the same shape as last batch's `getLatestNationalReportForEdition`: real,
tested-at-one-layer domain capability, never exposed the rest of the way — fixed, not left as a
discovered-but-unresolved note, per this batch's explicit instruction.

### §3 — Live verification, real seeded data

The canonical seed (`seedReferenceData`, used by every existing test) creates zero firm
organizations — confirmed by checking every test that needs a firm; each creates its own via
`createOrganization` directly, and none depend on `seedReferenceData` for firm data, so this
wasn't touched (avoids risk to the ~400 existing tests that already pass against it). Instead, a
verification-only script (not part of the repo, not part of any test) seeded six real firms
spanning six of the seven audience states via the same real `@cis/db` functions the domain
layer's own tests use (`createOrganization`, `insertFirmClaim`, `ensureSeats`/`setSeatState`,
`createOutreachLink`), directly against the running dev database — extending available data to
verify against, per this batch's instruction, without touching the shared canonical seed every
other test relies on.

Verified live, in a real browser, against that data:

- **Audience counts** — all seven firm audiences showed the exact live count matching the seeded
  state (1 each in six non-trivial states, 6 for "every firm").
- **Dedup enforcement** — a firm-audience send to an already-invited firm correctly reported
  "0 of 1 sent — 1 skipped, already received this template"; a send to a genuinely new firm sent
  correctly.
- **All four file-validation checks, individually triggered** — a five-row CSV correctly flagged
  `no_address`, `malformed_address`, and `in_file_duplicate` in one pass; a separate upload naming
  an already-invited real firm correctly flagged `already_sent` (closing the §2 gap above).
- **Delivery report accuracy, including the opened/clicked absent-vs-zero distinction** — real
  Zeptomail webhook events (`delivered`/`opened`/`clicked` for one recipient, `bounced` for
  another, via the existing `/invitations/zeptomail-webhook` route) produced a report showing
  Delivered 1 / Opened 1 ("indicative") / Clicked 1 / Bounced 1 for that batch, while every
  _other_ batch (never sent a webhook event) correctly showed "not reported" for opened/clicked —
  never zero.
- **Bounce list, no resend** — "List the addresses that bounced" correctly showed the one bounced
  address; no resend action exists anywhere in the UI or the routes underneath it.
- **Templates** — the `{{code}}` gate correctly disabled Save for a firm template missing
  `{{code}}` and enabled it once added; the new template persisted and appeared in the real list.
- **Access-request queue, submission through resolution** — a request submitted via the real
  `submitInvitationRequest` (the respondent-facing submission surface, UX-FRM-001, is out of
  scope) appeared correctly in the queue and the "Requests" tab count; both resolution paths were
  exercised — "Mark done without issuing" and "Issue a code" (the latter correctly created a real
  reissue batch, visible in "Messages sent").

No network errors (4xx/5xx) at any point across the full verification pass.

### §4 — Verification

New tests: `apps/admin/src/pages/InvitationsPage.test.ts` (a source scan, since this repo has no
DOM test infrastructure — asserts none of the old mockup's fixture arrays, hardcoded example
names/counts, or the stale "sending service not yet decided" placeholder remain in the file, that
the component signature takes real props, that every real client method is actually called, and
that no resend action exists); two new domain tests for `resolveFirmNamesToOrgs` and
`getBouncedRecipients` (`packages/domain/tests/invitations.test.ts`); two new HTTP-level tests for
the two new routes (`apps/api/tests/invitations-live-wiring.test.ts`).

Full suite: `pnpm test` — **42 files, 426 tests, all green** (up from 40/415) against a live
Postgres. `pnpm lint`, `pnpm typecheck`, `pnpm turbo build` all clean. `pnpm audit` unchanged.

### §5 — What's left from the running open-items list

Unaffected by this pass, still open from the last batch: national report approval is still
unreachable end-to-end (needs Phase 20's AI report exemplars before draft-sentence generation can
be built); scoring sign-off still has no reject capability at any layer; firm-report regeneration
still has no route. This pass closes the fourth and largest confirmed instance of the "mockup
never wired to its real backend" defect class; no fifth instance is currently known.

## Whole-Directory Mockup Sweep + Two Domain Gaps Closed

The previous four passes each ended with a version of "no further instance is currently known" —
a claim built by grepping for one specific header phrase (`"Self-contained functional surface
(local state)"`) plus a manual demo-toggle pattern. That is a weaker claim than it sounds: a page
using different, non-misleading header language would never match the grep, whether or not it has
the same underlying defect. This pass replaces it with a deliberate, page-by-page pass over every
file in `apps/admin/src/pages` (17 files), checked directly against three technical criteria
regardless of how each page's own comments describe itself: (a) local state standing in for live
API data, (b) a manual demo/state-toggle UI, (c) no real `client.*` call backing what the page
shows. Independently, it closes two small, previously-flagged domain gaps (§2 above: scoring
sign-off's missing reject path, firm-report regeneration's missing route).

### §1 — The definitive sweep: all 17 pages, no exceptions

| Page                     | Props                         | `client.` calls                    | Verdict                                                                                                                                                               |
| ------------------------ | ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DragnetPage.tsx`        | `{client, editionId}`         | 2                                  | **Confirmed real**                                                                                                                                                    |
| `EditionPage.tsx`        | `{client, editionId, viewer}` | 6                                  | **Confirmed real**                                                                                                                                                    |
| `FirmReportsPage.tsx`    | `{client, editionId}`         | 8                                  | **Confirmed real** (fixed in the Batch-1 pass, §2 above)                                                                                                              |
| `FirmResultsPage.tsx`    | none                          | 0                                  | **Genuine mockup + a distinct auth-mismatch defect** — see §2                                                                                                         |
| `FirmTeamPage.tsx`       | `{client, editionId}`         | 6                                  | **Confirmed real**                                                                                                                                                    |
| `InvitationsPage.tsx`    | `{client, editionId}`         | 11                                 | **Confirmed real** (fixed above, largest instance)                                                                                                                    |
| `LoginPage.tsx`          | `{onSignIn}`                  | 0 (calls the standalone `login()`) | **Confirmed real** — different call shape, genuinely live                                                                                                             |
| `MissionBoardPage.tsx`   | `{client, editionId}`         | 1                                  | **Confirmed real** (fixed, first instance)                                                                                                                            |
| `NationalReportPage.tsx` | `{client, editionId, viewer}` | 7                                  | **Confirmed real** — the page itself is wired; its _approval flow_ is separately blocked by the missing draft-sentence generator (already flagged, out of scope here) |
| `PeopleAccessPage.tsx`   | none                          | 0                                  | **Genuine mockup** — see §2                                                                                                                                           |
| `RegulatorsPage.tsx`     | none                          | 0                                  | **Not a defect** — documented, deliberate scope boundary — see §2                                                                                                     |
| `RendererPage.tsx`       | `{client}`                    | 1                                  | **Confirmed real**                                                                                                                                                    |
| `ResponsesPage.tsx`      | none                          | 0                                  | **Genuine mockup** — see §2                                                                                                                                           |
| `ScoresSignoffPage.tsx`  | `{client, editionId, viewer}` | 6 (now incl. `rejectSignoff`)      | **Confirmed real** (fixed; extended in §2a below)                                                                                                                     |
| `SurveysPage.tsx`        | `{client, editionId, viewer}` | 3                                  | **Confirmed real**                                                                                                                                                    |
| `UnfinishedPage.tsx`     | none                          | 0                                  | **Genuine mockup** — see §2                                                                                                                                           |
| `WordingPage.tsx`        | `{client}`                    | 4                                  | **Confirmed real**                                                                                                                                                    |

**Totals: 12 confirmed real, 4 genuine mockups, 1 (of the 4) additionally carries a second, distinct
defect, 1 documented non-defect, 0 ambiguous.** Every page was read in full, not just grepped; the
zero-prop/zero-`client.`-call signature is a triage heuristic, not the verdict — `LoginPage.tsx` is
the proof it can false-positive (it calls a standalone `login()` export, not the `client` object,
and is genuinely live).

### §2 — The five flagged pages, corrected: three categories, not one "mockup" bucket

An earlier version of this section put all five pages in one "confirmed mockup" bucket. That
conflated three genuinely different things: a page whose own local state stands in for a real,
unused backend (the actual mockup defect this whole programme has been fixing); a page with a real
but _differently-shaped_ defect; and a page that is not a defect at all. Restated precisely, with
the exact state variable and exact missing/mismatched call for each:

**Category 1 — Genuine mockup (same shape as the five already fixed: local state/demo toggle
standing in for a real, callable backend that exists and is never called).**

- **`PeopleAccessPage.tsx`** — `const [people, setPeople] = useState<Person[]>(() => clone(SEED))`,
  where `SEED` is a hardcoded four-person literal array. `save()`, `removePerson()`, and every
  other mutation call only `setPeople(...)`, held in React state and discarded on reload; there is
  no `client.*` call anywhere in the file (zero props — `PeopleAccessPage(): JSX.Element`). Real,
  tested, fully-routed backend already exists and enforces the same rules server-side
  (`GET/POST/PATCH/DELETE /people` in `apps/api/src/routes/people.ts` →
  `packages/domain/src/people-access-service.ts`, including the two-approver floor and
  self-removal — both independently re-verified live over HTTP below, §2b) — never called.

- **`ResponsesPage.tsx`** — `const CARDS: Card[] = [...]` and `const DEPS: DepRow[] = [...]` are
  hardcoded literal arrays (four segment cards, six dependency rows, e.g.
  `{current: 61, target: 80, forecast: 74, ...}`) rendered directly with no state and no props
  (`ResponsesPage(): JSX.Element`); no `client.*` call anywhere in the file. There is no demo-toggle
  UI here specifically (it is a pure read-only render of the two constants — criterion (b) does not
  apply to this one), but criteria (a) and (c) are both fully met. Real, tested, routed backend
  already exists (`GET /editions/:id/responses-monitor` in `apps/api/src/routes/monitoring.ts` →
  `getResponsesMonitor` in `responses-monitoring-service.ts` — the exact computation Mission
  Board's own conditions 7/8 already read from, post-fix) — never called.

- **`UnfinishedPage.tsx`** — `const DATA = {started: 1874, done: 1406, ...}`, `const STOPS = [...]`,
  and `const [schedule, setSchedule] = useState<ScheduleStep[]>(INITIAL_SCHEDULE)` where
  `INITIAL_SCHEDULE` is a hardcoded three-step literal. The page's own "On/Off" toggle buttons and
  day-count inputs (`toggleStep`, `setStepValue`) mutate only this local `schedule` state; no
  `client.*` call anywhere persists it. Zero props, zero `client.*` calls. Of the three pages in
  this category, this one's editable schedule is the closest analogue to a genuine demo-toggle: it
  visually behaves like a working settings screen while doing nothing. Real, tested, routed backend
  already exists (`GET /editions/:id/unfinished`, `PUT /reminders/schedule`, `PUT /reminders/cap`,
  `POST /editions/:id/reminders/run` in `monitoring.ts` → `reminder-timing-service.ts`) — never
  called.

- **`FirmResultsPage.tsx`** — `const IDX: Idx[] = [...]` (five hardcoded index rows with fixed
  `you`/`ind` numbers) plus an explicit, literal demo-toggle button row:
  `<button onClick={() => setRetail(47)}>Retail unlocked</button>`,
  `onClick={() => setRetail(19)}` "Directional only", `onClick={() => setRetail(6)}` "Below the
  floor" — three buttons that switch one `useState<number>(47)` between three canned values to fake
  three different retail-cut states. Zero props, zero `client.*` calls. Of all five pages, this is
  the single most literal match to the original criterion (b) — structurally identical in shape to
  Mission Board's now-removed fake "Edition phase" toggle. **On its own technical merits this is a
  genuine Category-1 instance**, independent of the auth question below.

**Category 2 — A real defect, but a different shape (not the mockup pattern).**

- **`FirmResultsPage.tsx` additionally** — a real, tested backend already exists
  (`getFirmResults` in `packages/domain/src/firm-results-service.ts`, exposed at
  `GET /editions/:editionId/firms/:firmId/results` in `apps/api/src/routes/firm-results.ts`), so
  the reason this page cannot simply be wired the way the other three above can is not "the backend
  doesn't exist" — it's an **auth-model mismatch**. That route authenticates via a coordinator
  access code header (`x-coordinator-access-code`, checked against `getCoordinatorByAccessCode`) —
  its own file comment says outright "it is not operator-authenticated... coordinator-only (§9)."
  But the page is rendered at `tab === 'firmresults'` **inside `App.tsx`'s operator-session-gated
  tree**, reached only after a normal `/auth/login` as an operator. Even after the `IDX` array and
  the toggle are replaced with a real fetch, there is today no operator-session-authenticated path
  to call this specific route: does the operator hold or enter a coordinator's own access code?
  does a firm-picker get added? does a second, operator-scoped variant of the route need to be
  built? This is not a working backend that simply went uncalled (the mockup pattern) — it's two
  correctly-built pieces (the route, for a coordinator caller; the page, inside an operator
  session) that were never meant to call each other as-is, and need a decision before either can
  change.

**Category 3 — Not a defect.**

- **`RegulatorsPage.tsx`** — its own file header states, verbatim: "Local state stands in for the
  live edition here, exactly as the other Study Operations surfaces do — a DELIBERATE scope
  decision (documented in the README), not yet wired to the live per-role API." That same decision
  is independently documented at this README's own "Deliberate scope decision —
  `RegulatorsPage.tsx` stays a local-state mockup" note, written before this sweep ever ran. It
  technically matches the same (a)/(c) criteria as the four pages above — zero props, zero
  `client.*` calls, a local `SEED`-shaped state — but it is the one page on this list that honestly
  discloses this in its own code, and was already a known, reviewed, intentional boundary. Not a
  hidden gap; not fixed here because there is nothing to fix — carried forward unchanged.

None of the four Category-1 pages is fixed in this pass — none is "a handful of lines"; each is
comparable in size to `InvitationsPage.tsx` (the largest prior fix), and `FirmResultsPage.tsx`
additionally cannot be fixed at all until its Category-2 auth question is decided. Three of the
four Category-1 pages, and the Category-2 finding, are **not new discoveries**: they were already
checked in the Design Reconciliation Audit (Batch 1, above) and excluded from that fix on a
narrower test ("does the header say 'self-contained,' the misleading phrasing") than this pass's
literal technical criteria ("does it match the shape, regardless of what the header calls it").
Re-applying the literal criteria here means they now appear on this list; it does not mean they
were hidden before. Per this task's own instruction, each is reported and stopped, for a future
dedicated pass.

### §2b — Error-handler bug: blast-radius assessment against every prior live-verification claim

The error-handler ordering bug (full description in §3 below) means every domain error thrown from
inside any route handler, on any route, always returned Fastify's generic 500 instead of the
intended classified 4xx — for the entire lifetime of this repository, not just the two new
endpoints this pass added. Before treating that as closed, every check in this programme's history
that was specifically claimed as **live-verified in a real browser or over real HTTP, checking an
error/rejection outcome**, was re-examined against the actual source and the actual prior wording,
to determine whether any of those claims was unknowingly resting on the bug (a masked 500 that
happened to still look like "it failed" to whoever was watching).

**Finding: none of them were.** Every prior "live-verified"/"real browser" claim in this README, on
inspection, exercised a **success** path (approve-by-a-different-user, a real save, a real
generation) — routes that return `reply.status(201).send(...)`/`reply.send(...)` directly, which
never passes through `resolveStatusCode` at all regardless of registration order. No prior claim in
this README asserted a specific error status code or error message for a rejection path over real
HTTP. That is confirmed by re-reading each relevant section directly, not assumed:

| Item from the request                                | Real check found                                                                                                                                                                                                                                                                                                      | Ever claimed live/HTTP-verified for an ERROR path?                                                                                                                          | Affected by the bug?                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Edition lock self-approval                           | `MakerCheckerViolationError` (403), `apps/api/src/routes/editions.ts`                                                                                                                                                                                                                                                 | No — §"Save/freeze flow" (above) verified only the approve-by-different-user success path                                                                                   | Yes, structurally (never previously exercised live)                                                                                             |
| Instrument freeze self-approval                      | Same class, `routes/instruments.ts`                                                                                                                                                                                                                                                                                   | No — same section, success path only                                                                                                                                        | Yes, structurally                                                                                                                               |
| Scoring sign-off self-approval                       | `ScoringSignoffError`/`SELF_APPROVAL` (409)                                                                                                                                                                                                                                                                           | No — Design Reconciliation Batch 1 verified only approve-by-different-user                                                                                                  | Yes, structurally                                                                                                                               |
| Scoring sign-off self-**rejection** (new, this pass) | `ScoringSignoffError`/`SELF_REJECTION` (409)                                                                                                                                                                                                                                                                          | **Yes** — browser + direct HTTP, in §2 above                                                                                                                                | No — verified _after_ the fix landed; correct                                                                                                   |
| Regulator engagement "referral" self-block           | —                                                                                                                                                                                                                                                                                                                     | N/A — no such maker-checker mechanism exists in `regulator-engagement-service.ts`; "referral" there means cancel-and-restart of a survey link, not a request/approve action | Not applicable                                                                                                                                  |
| Two-approver-floor refusal on `PeopleAccessPage.tsx` | `PeopleAccessError`/`APPROVER_FLOOR` (409), real backend in `people-access-service.ts`                                                                                                                                                                                                                                | No — the page itself is a Category-1 mockup (§2 above); anything ever "seen" on it was the page's own local, fake check, never the real server rule                         | Yes, structurally (the real rule was never live-exercised through this page at all)                                                             |
| Regulator-contact email/phone validation             | `RegulatorEngagementError`/`CONTACT_EMAIL_INVALID`/`CONTACT_PHONE_INVALID` (409)                                                                                                                                                                                                                                      | No — no README section claims a live/HTTP check of this                                                                                                                     | Yes, structurally                                                                                                                               |
| Firm-coordinator validation                          | PIN check (`FirmTeamError`/`INVALID_PIN`, 409; `PinVerificationError`, 403) — there is no separate email/phone check for coordinators in `firm-team-service.ts`                                                                                                                                                       | No — no README section claims a live/HTTP check of this                                                                                                                     | Yes, structurally                                                                                                                               |
| Required-clause violations (managed content/Wording) | `ManagedContentError`/`REQUIRED_CLAUSE_MISSING` (409)                                                                                                                                                                                                                                                                 | No — domain-tested only (`phase18.test.ts`), never claimed live/HTTP                                                                                                        | Yes, structurally                                                                                                                               |
| Forbidden-phrase check (privacy notice)              | `ManagedContentError`/`FORBIDDEN_PHRASE_PRESENT` (409)                                                                                                                                                                                                                                                                | No — same, domain-tested only                                                                                                                                               | Yes, structurally                                                                                                                               |
| Consent-gate refusal (PAT-011, S5a/S5b)              | `ConsentRequiredError` (403)                                                                                                                                                                                                                                                                                          | No — domain-tested only (`response-service.ts` tests), never claimed live/HTTP                                                                                              | Yes, structurally                                                                                                                               |
| `InvitationsPage.tsx` file-validation checks         | `validateUploadFile` returns a `problems: [...]` array in a normal `200` response — it does not throw                                                                                                                                                                                                                 | N/A — this path never touches `resolveStatusCode` regardless of the bug                                                                                                     | No                                                                                                                                              |
| `InvitationsPage.tsx` `{{code}}` gate                | Server: `InvitationsError`/`CODE_PLACEHOLDER_REQUIRED` (409). But the live-verification claim ("correctly disabled Save for a firm template missing `{{code}}`") is client-side: `InvitationsPage.tsx` has its own presence check (`clientErr`, line ~740) that disables the Save button _before_ any request is sent | No — the request that would hit the server's rule was never actually sent in that check                                                                                     | Server-side rule: yes, structurally (never live-exercised); the client-side check that WAS observed is unaffected (it never reaches the server) |

**Domain-level tests for every row above already existed and already passed** (`phase18.test.ts`,
`response-service.test.ts`, `edition-service.test.ts`/`instrument-freeze.test.ts`,
`people-access-service`'s own tests, etc.) — those call the service functions directly and never go
through Fastify, so they were **never** affected by this bug regardless. The bug lived exclusively
in the HTTP layer, and no prior HTTP-level test in this repository asserted an error-path status
code at all (confirmed directly: this pass's own two new HTTP test files are the first ones that
do). So nothing above was a false positive in the sense of "we said it passed and it didn't" — the
gap is narrower and specific: the real, correct, classified HTTP behavior for every one of these
rules had simply never been checked before, at the HTTP layer, by anyone, ever.

**Re-verification performed now, live, against a freshly seeded `cis_dev`** (the two-new-endpoint
verification in §2 above already covers the scoring-reject row; the following covers a
representative sample of the remaining structurally-affected rows, each a different error class and
a different route file, run against the built server via real `app.inject()` HTTP calls after the
fix):

| Check                                                                           | Result                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instrument freeze, self-approval                                                | `403 MakerCheckerViolationError` — "Maker-checker violation: user … cannot both request and approve/reject critical action …"                                |
| Edition lock, self-approval                                                     | `403 MakerCheckerViolationError` — same message shape                                                                                                        |
| Scoring sign-off, self-approval                                                 | `409 ScoringSignoffError` — "A maker can never approve their own sign-off request"                                                                           |
| People & Access, two-approver-floor refusal (real backend, not the mockup page) | `409 PeopleAccessError` — "This person is one of the last two approvers and cannot be removed. Give somebody else the approval right first, then come back." |
| Regulator contact, invalid email                                                | `409 RegulatorEngagementError` — "That is not a working email address"                                                                                       |

All five came back with their intended, correctly-classified status code and the exact intended
message — none of them 500, none of them the generic Fastify shape. This directly confirms the fix
in §3 below applies platform-wide, not only to the two routes this pass added, across three
different maker-checker services (edition, instruments, scoring), the People & Access service, and
the regulator-engagement service. The remaining rows in the table above (required clauses,
forbidden phrases, consent gate, firm-coordinator PIN) were not individually re-run live — they
share the identical mechanism (a `DomainError` subclass thrown inside a route handler, resolved by
the same `resolveStatusCode`/`setErrorHandler` this fix corrects) and no prior claim about them
needs correcting, so a further live pass would confirm the same mechanism a sixth, seventh and
eighth time rather than surface new information.

### §3 — 2a: scoring sign-off can now be rejected

`packages/domain/src/scoring-signoff-service.ts` gains `rejectSignoff(pool, {signoffId,
rejectedBy, reason})`, mirroring `approveSignoff`'s exact shape: only a `requested` sign-off can be
rejected, the rejecter can never be the requester (`ScoringSignoffError`/`SELF_REJECTION` — the
same class and pattern as the existing `SELF_APPROVAL`), and a reason is required
(`SignoffPayloadError` if blank, the same error class the checked-account validation already
uses). `ScoringSignoffState` gains `'rejected'` (`packages/shared-types`); a rejected sign-off is
treated the same as `superseded` for "liveness" — `getLiveSignoffForRun` already excludes both, so
a maker can submit a fresh request for the same run immediately after a rejection, with no schema
change needed there.

New migration `20260919000000_phase24-scoring-signoff-reject.js` adds `rejected_by`/`rejected_at`/
`rejection_reason` to `scoring_signoffs`, widens the `state` CHECK to include `'rejected'`, and adds
two new CHECK constraints mirroring the table's existing ones: `rejected_by <> requested_by` (the
same maker-checker shape as the existing `approved_by` CHECK) and a rejected row must carry all
three rejection fields (mirroring the existing signed-off-fields CHECK). New
`rejectSignoffRow` in `packages/db/src/queries/scoring-signoffs.ts` mirrors `approveSignoffRow`'s
guarded single-UPDATE shape exactly.

New route `POST /scoring-signoffs/:signoffId/reject` (`apps/api/src/routes/scoring.ts`), taking
`{rejectedBy, reason}` — the same body-carries-actor shape `approve` already uses, not the
JWT-`sub` shape `people.ts` uses (kept consistent with this route file's own existing convention,
not changed). New `client.rejectSignoff(signoffId, rejectedBy, reason)` in
`apps/admin/src/api/client.ts`.

`ScoresSignoffPage.tsx`'s review section — which previously offered only "Approve and sign off,"
with a header comment explicitly noting the old mockup's Reject button was never backed by a real
capability — now offers a real "Reject" action: clicking it reveals a required reason field, and
submission calls the real route. The requester sees the rejection (who, when, why) the next time
they view the run, with a fresh "Request approval" control immediately available again. The
self-check is enforced at three independent layers, each verified: the UI hides both decision
controls entirely for the requester's own request (not merely disables them — same convention as
the platform's other maker-checker reviews); a direct HTTP call as the requester is refused with a
clean `409 SELF_REJECTION`; and the DB's own CHECK constraint is the structural backstop under both.

**A pre-existing bug found and fixed while adding this**: `apps/api/src/server.ts` registered its
custom `setErrorHandler` **after** every route plugin (`app.register(scoringRoutes)`, etc.).
Fastify resolves a route's error handler from its plugin-encapsulation context at _registration_
time, not dynamically per request — a handler set on the root instance after a child plugin has
already registered its routes never applies to that plugin's routes. The practical effect: **every
domain error thrown from inside any route handler in this entire API, always, returned Fastify's
generic default 500 response instead of the intended classified 4xx** — the whole
`resolveStatusCode` name-to-status mapping (self-approval → 409, validation → 400, permission → 403,
etc.) had never actually been reachable, for any route, at any point. This was never caught before
because no existing HTTP-level test in the repo asserted a 4xx domain-error response over real
`app.inject()` — every prior HTTP test asserted only the happy path. Fixed by moving
`app.setErrorHandler(...)` to before the route registrations, and hardening `resolveStatusCode`
itself to check the name-based switch before falling back to `error.statusCode` (Fastify assigns
every thrown error a default `statusCode` of 500 before the handler ever sees it, so checking that
field first would have silently defeated the switch even with correct registration order). Proven
by the two new HTTP-level test files below, both of which assert real 409/400 responses that would
have failed loudly against the old code (confirmed directly: they did fail, with the generic
Fastify shape, before this fix).

### §4 — 2b: firm-report regeneration now has a route

`regenerateFirmReport(pool, id)` already existed in `packages/domain/src/firm-report-service.ts`
and was already exported from the package — confirmed directly before doing anything else, per
this task's own instruction to check first. It was not, in fact, already tested anywhere (the
prior write-up's "exists and is tested" was half right); no test file referenced it. It also had
one real gap of its own: it would call `setGenerationState` unconditionally, with no check for an
already-`released` report — the DB's own `prevent_released_firm_report_change` trigger would
eventually refuse it, but as a raw, unclassified Postgres exception (a 500), not a clean domain
error. Fixed by adding the same released-state check the rest of this module already performs
elsewhere, throwing `FirmReportError`/`ALREADY_RELEASED` (409) before ever reaching the DB.

New route `POST /firm-reports/:id/regenerate` (`apps/api/src/routes/reporting.ts`). New
`client.regenerateFirmReport(reportId)` in `apps/admin/src/api/client.ts`.
`FirmReportsPage.tsx`'s existing "N of M failed to generate and are HELD" warning box — which
previously said outright "Retrying generation from this page is not yet available" — now lists
each held firm with a real "Retry generation" button, calling the real route.

### §5 — Live verification, real seeded data

Both flows were driven end to end in a real browser (Playwright/Chromium) against the dev API and
admin servers, freshly migrated and seeded, with the edition advanced to `locked` (via the same
domain functions the tests use, not a UI shortcut — a fresh seed starts in `draft`, and this admin
UI currently has no "trigger a second run" control beyond the very first one, so a second run was
created directly over HTTP as the seeded maker user, the same way the verification methodology has
done throughout this programme when a screen doesn't yet expose every setup step it depends on):

- **Reject, two different seeded users**: requested sign-off as the maker; reviewed and rejected
  as the checker with a real reason ("Population counts look stale — please re-check before
  resubmitting."); the run's row in the Runs table updated to a red "Rejected" pill immediately for
  the checker. Reloading as the maker showed the same reason, attributed to the checker, by name
  and timestamp, with the "Request approval" control available again on the same run — matching the
  domain rule directly, not just a page refresh coincidence.
- **Self-rejection, both layers**: as the maker viewing their own pending request, neither
  "Approve and sign off" nor "Reject" render at all (checked by element count, not just visual
  inspection). A direct HTTP call attempting the same self-rejection was refused with a real
  `409 SELF_REJECTION` and the exact domain message.
- **Firm-report retry, real held state**: seeded one firm (via the same out-of-repo
  verification-script pattern used for `InvitationsPage`, since the canonical seed creates zero
  firms) with a genuine generation failure (`generateFirmReports(..., failFor: [firmId])`, the same
  mechanism `packages/domain/tests/firm-report.test.ts` uses). The page correctly showed "1 of 4
  failed to generate and are HELD" with a "Retry generation" button; clicking it made the warning
  box disappear entirely and the firm's row gain a real "Approve" control, meaning generation had
  genuinely succeeded, not just re-rendered.
- The already-released-report refusal (`ALREADY_RELEASED`) was **not** driven through the full live
  UI: reaching a genuinely `released` report requires the national report to be approved first,
  which is the already-flagged, out-of-scope blocker (§ above) — pushing a report to `released`
  live would mean routing around that blocker, not verifying this one. It is proven instead at both
  the domain layer (`packages/domain/tests/firm-report.test.ts`) and the HTTP layer
  (`apps/api/tests/firm-report-regenerate.test.ts`), each against a report genuinely taken through
  `releaseFirmReports` first.

### §6 — Tests

New domain-level tests: four in `packages/domain/tests/scoring-signoff.test.ts` (self-rejection
blocked, reason required, a rejected run is free for a fresh request, cannot reject a non-requested
sign-off) and two in `packages/domain/tests/firm-report.test.ts` (a failed report regenerates and
is recorded in the release history; an already-released report refuses with `ALREADY_RELEASED` and
is left genuinely unchanged). New HTTP-level test files:
`apps/api/tests/scoring-signoff-reject.test.ts` (success, self-rejection 409, empty-reason 400) and
`apps/api/tests/firm-report-regenerate.test.ts` (success, already-released 409) — both of which
also exercise (and would have caught) the error-handler ordering bug above.

Full suite: `pnpm test` — **44 files, 437 tests, all green** (up from 42/426: +6 domain tests,
+5 HTTP-level tests across the two new files) against a live Postgres. `pnpm lint`, `pnpm
typecheck`, `pnpm turbo build` all clean. `pnpm audit` unchanged — the same three pre-existing
devDependency advisories as every prior phase (`js-yaml` via `eslint`), no `package.json` or
lockfile touched.

### §7 — Running list of open items needing a decision (not resolved here)

1. **National report approval is currently unreachable end-to-end** — needs a product decision on
   how draft sentences get produced before the adversarial-checker gate can ever pass. Unchanged by
   this pass; explicitly out of scope.
2. **`FirmResultsPage.tsx` (UX-FRM-RES-001)** — a genuine Category-1 mockup (§2) that additionally
   carries a Category-2 defect: the route is coordinator-access-code-authenticated while the page
   sits behind the operator-authenticated admin session. Needs a product decision on the auth model
   _before_ it can even be wired, then a dedicated pass.
3. **`PeopleAccessPage.tsx` (UX-OPS-006)** — a genuine Category-1 mockup (§2): "local-state mockup,
   never calls its own real routes," same shape as the four already fixed. Real, fully-routed
   backend already exists. Needs a dedicated pass — three views, real CRUD, replacing the hardcoded
   "signed-in operator" with the real session identity.
4. **`ResponsesPage.tsx` (UX-OPS-003)** — a genuine Category-1 mockup (§2); real, routed backend
   already exists (`getResponsesMonitor`, the same computation Mission Board already reads). Needs
   a dedicated pass.
5. **`UnfinishedPage.tsx` (UX-OPS-004)** — a genuine Category-1 mockup (§2); real, routed backend
   already exists (`reminder-timing-service.ts`), including the schedule/cap the page's own UI
   edits only locally today. Needs a dedicated pass.
6. **`RegulatorsPage.tsx` (UX-OPS-007)** — unchanged: an honestly, previously self-disclosed
   deliberate scope decision, not a hidden gap. No action needed beyond what's already documented.

Removed from this list, now resolved: scoring sign-off's missing reject capability (§3 above) and
firm-report regeneration's missing route (§4 above). This pass also closes the earlier "no fifth
instance is currently known" claim with a verified one: the whole-directory sweep found four
further pages matching the technical mockup shape (items 2–5 above), none of them new or hidden —
each already reviewed once and excluded from an earlier pass on a narrower test than this one used
— and confirms no other page in the directory is unaccounted for.

## Re-validation of the 12 "confirmed real" pages, and three of the four mockups fixed

A follow-up review correctly pointed out that the "12 confirmed real" side of the whole-directory
sweep had not been checked with the same rigor as the mockup side — a page was called real if the
word `client` appeared in the file, not by tracing the specific rendered variable to a specific real
call. This re-does that check properly, then fixes three of the four Category-1 mockups the sweep
found, and reports (rather than silently resolving) a genuine decision blocker on the fourth — plus
a fifth, much larger mockup this whole programme had never looked at, found while investigating
that blocker.

### Re-validation: all 12 hold up, with line-level evidence

Every one of the 12 was read in full and checked exactly the way `SEED`/`CARDS`/`DEPS`/`DATA`/
`STOPS` were: identify every rendered piece of data and every offered action, quote the exact line
defining it, quote the exact line of the real call backing it.

| Page                     | Data/action → real call (file:line)                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DragnetPage.tsx`        | `firms`/`friction` (70-71) ← `client.get(.../dragnet/maturity)` / `.../friction` (84-85)                                                                                                                                         |
| `EditionPage.tsx`        | `edition` (52) ← `client.getEdition` (63); `requestLock`(113), `decideLock`(133), `setOpeningDate`(201), `setClosingDate`(243), `setFloors`(299)                                                                                 |
| `FirmReportsPage.tsx`    | `reports`/`firms`/`authoritativeRunId`/`nationalApproved` (32-35) ← 4 real calls (48-57); `generateFirmReports`(153), `approveFirmReport`(224), `regenerateFirmReport`(261), `releaseFirmReports`(312)                           |
| `FirmTeamPage.tsx`       | `firms`/`coordinators` (150,152) ← `listFirms`(160)/`listCoordinators`(173); 5 further actions (210-241); nested cards use `client.get`/`put` (44,57,104)                                                                        |
| `InvitationsPage.tsx`    | 5 top-level pieces ← 5 real calls (81-91); 6 further actions (295-914)                                                                                                                                                           |
| `LoginPage.tsx`          | standalone `login()` (import line 2, called line 17)                                                                                                                                                                             |
| `MissionBoardPage.tsx`   | `cards`/`phase` (83-84) ← `client.getMissionBoard`(90). Noted, not a defect: the `RAIL` nav buttons (182-197) have no `onClick` — inert by design, previously disclosed                                                          |
| `NationalReportPage.tsx` | `report`/`sections`/`pre`/`authoritativeRunId` (48-52) ← 3 real calls (66-79); 4 further actions (197-402). The missing sentence-generator is an honest UI disclosure of an already-flagged, out-of-scope gap, not a page defect |
| `RendererPage.tsx`       | `items` (17) ← `client.getInstrumentItems`(26). `answers` (18) is intentionally ephemeral preview-input state — the page's own header says it is not a respondent journey                                                        |
| `ScoresSignoffPage.tsx`  | `runs`/`signoffs`/`scores` (47-49) ← 2 real calls (60,65); 4 further actions (146-440)                                                                                                                                           |
| `SurveysPage.tsx`        | `data` (25) ← `client.getInstruments`(33); `requestFreeze`(74), `decideFreeze`(94)                                                                                                                                               |
| `WordingPage.tsx`        | `areas`/`state` (43,46) ← `client.get`(55,78); `client.post` drafts/publish (113,137)                                                                                                                                            |

**Verdict: all 12 are genuinely, fully real.** No gap survived this level of scrutiny.

### Three of the four Category-1 mockups fixed — same rigor as the five before them

`PeopleAccessPage.tsx`, `ResponsesPage.tsx` and `UnfinishedPage.tsx` are now live-wired. Each real
backend (`people-access-service.ts`, `responses-monitoring-service.ts`,
`reminder-timing-service.ts`) already existed and was already tested at the domain layer — this was
wiring, not a rebuild.

- **`PeopleAccessPage.tsx`** now takes `{client, viewer}` (was zero props). The hardcoded `SEED`
  array is gone; `client.getPeople()`/`addPerson()`/`updatePersonRights()`/`removePerson()` (new
  `AdminClient` methods, `apps/api/src/routes/people.ts`, pre-existing) back the list, add, edit and
  remove actions. `ME_EMAIL` is gone — self-identification (hiding the self-removal action) now uses
  the real `viewer.email`. The `criticalActions` table now renders the server's own list rather than
  a duplicated local constant. The two-approver floor and self-removal refusals are unchanged
  server-side rules (already live-verified over real HTTP in the previous pass); this pass confirms
  they now reach the UI: a real add persisted past reload, and the client-side "cannot remove"
  hints track the server's real `approvers` count, not a client-recomputed guess from fake data.
- **`ResponsesPage.tsx`** now takes `{client, editionId}`. `CARDS`/`DEPS` are gone;
  `client.getResponsesMonitor(editionId)` backs every segment card and dependency row, rendering the
  server's own `greyBarPct`/`redMarkerPct`/`completeFirm` fields directly rather than recomputing
  them from fake numbers.
- **`UnfinishedPage.tsx`** now takes `{client, editionId}`. `DATA`/`STOPS`/`INITIAL_SCHEDULE` are
  gone; `client.getUnfinished(editionId)` backs the stats and drop-off histogram. The schedule
  editor — the part flagged as needing REAL persistence, not just a local toggle — now mutates a
  draft only, with an explicit "Save schedule"/"Save cap" action calling
  `client.setReminderSchedule`/`setReminderCap` (`PUT /reminders/schedule`, `PUT /reminders/cap`,
  pre-existing routes). Two fields the old mockup showed (`started`, `done`, `daysLeft`) have no
  real backing anywhere in the domain layer and are not reproduced with invented substitutes — the
  real `UnfinishedStats` type only has `unfinished`/`reachable`/`unreachable`, so that is what is
  shown; likewise the real `DropoffBucket` carries a raw `questionId`, not a human-written label, so
  the raw code is shown rather than inventing prose for it.

New regression tests (source-scan, matching `InvitationsPage.test.ts`'s convention — no DOM test
infrastructure exists in this repo): `PeopleAccessPage.test.ts`, `ResponsesPage.test.ts`,
`UnfinishedPage.test.ts`, each asserting the old fixture identifiers are gone, the page takes real
props, and every real `client.*` method is actually called.

**Live-verified in a real browser, freshly seeded `cis_dev`:**

- Added a real person via the UI; the roster showed the real new row (not a fixture) and reloading
  the page did not lose it.
- Responses showed real dependency-row IDs straight from the database (`FIRM_TIER_HEATMAP`,
  `IEI_ICI_BY_SEGMENT`, `LOCAL_VS_FOREIGN` — none of which existed in the old mockup's six
  hardcoded rows), and real segment-card numbers (0 of 80, 66 days left) matching the fresh seed.
- On Unfinished, toggled the first reminder step off and saved — the "2 are currently on" count
  updated immediately. **Reloaded the entire page from scratch** and re-navigated back: the step
  was still "Off". This is the specific proof the task asked for — the schedule editor persists a
  real change server-side, it does not just mutate local state that resets on refresh.

### `FirmResultsPage.tsx` — decision made, then a bigger blocker found underneath it

Per explicit instruction, the auth-model question was not resolved unilaterally. Asked directly:
should the admin app grow a new operator-permission-gated route reusing `firm-results-service.ts`
(the original recommendation), leave the coordinator-access-code route as the only path and remove
this page from the admin app, or a more conservative gated variant of the first option.

**Decision made: move the real results view into `FirmPortal.tsx`** — the surface that already
holds the firm-coordinator's own space, not the operator admin app — and remove `FirmResultsPage.tsx`
and its "Firm results" tab from the operator-facing pages entirely. The reasoning: `firm-results.ts`'s
route was built for a coordinator caller from day one (`x-coordinator-access-code` header); an
operator-facing detour was never authorized by the artefact and would be a new privacy decision, not
a wiring fix. Finishing what Phase 14 built means connecting it to the coordinator, not to the
operator.

**Investigating that move surfaced a reason to stop, per the task's own instruction not to proceed
past a wrong premise:** `FirmPortal.tsx` (`apps/admin/src/firm/FirmPortal.tsx`) is not, in fact, a
real coordinator-authenticated surface to attach a results section to. It is itself a complete,
1,398-line, entirely local-state mockup — a hardcoded `ACCOUNTS` dictionary of three demo email/PIN/
code combinations stands in for the whole claim-and-sign-in flow, seat assignment mutates only
`useState`, outreach volumes are hardcoded (`148`/`38`/`26`/…), and the "closed" phase's own "Open
your results" button is not even wired to fake data — it calls `alert(...NOT_STARTED...)`. A direct
check confirms **zero** `client.`/`fetch(` calls anywhere in the file. It is rendered from its own
separate entry point (`apps/admin/src/main.tsx`, `<FirmPortal />` directly), outside `App.tsx`'s
routing entirely, which is why the whole-directory sweep (scoped to `apps/admin/src/pages`) never
saw it.

Worse for the specific plan: the real backend's own routes are honest about the same gap. The
firm-portal API routes' header comment states outright: "Seat and outreach management are
operator-authenticated for now, matching the Phase 3 firm-team routes (**a firm-coordinator login
surface is a later phase**)." There is no real coordinator session or login mechanism anywhere in
this codebase — `firm-results.ts`'s raw access-code header is the only coordinator-credential check
that exists, and nothing issues, stores, or verifies a coordinator session around it. "Give
`FirmPortal.tsx` a results tab that calls the existing route with the access code already used
elsewhere in the portal" is not achievable as stated, because no real access-code flow exists in
the portal to reuse — the portal's own code check is a hardcoded `=== acct.code` string comparison
against the fixture dictionary, not a real credential check of any kind.

**Not resolved here — reported, per instruction, rather than built on a false premise.** This is a
sixth instance of the local-state-mockup defect class, larger than any found so far (it exceeds
`InvitationsPage.tsx`, the previous largest), and it blocks the chosen resolution for
`FirmResultsPage.tsx` until it is itself wired — at minimum, a real coordinator claim/sign-in flow
against `firm-portal-service.ts`'s real, tested domain logic. `FirmResultsPage.tsx` and its admin
nav tab are **not yet removed**, pending confirmation of how to sequence this against a genuine
`FirmPortal.tsx` fix — removing the tab now would leave firm results reachable from nowhere in the
running application.

### Verification

Full suite: `pnpm test` — **47 files, 450 tests, all green** (up from 44/437: +3 new admin-side
regression test files / +13 tests — no new domain/HTTP tests, since the routes these three pages
wire to are pre-existing and already covered there) against a live Postgres. `pnpm lint`,
`pnpm typecheck`, `pnpm turbo build` all clean. `pnpm audit` unchanged — the same three pre-existing
devDependency advisories as every prior phase.

### Running list of open items needing a decision (updated)

1. **National report approval is currently unreachable end-to-end** — unchanged, out of scope.
2. **`FirmPortal.tsx` is a complete, unwired local-state mockup** (newly found, this pass) — the
   platform's largest confirmed instance of the defect class, and now also a hard blocker for
   `FirmResultsPage.tsx`'s chosen resolution. No real coordinator login/session mechanism exists
   anywhere in this codebase yet. Needs its own dedicated pass before firm results can move there.
3. **`FirmResultsPage.tsx`** — decision made (results belong in `FirmPortal.tsx`, not the operator
   admin app), but not yet executed pending item 2. The page and its admin nav tab remain in place
   for now so the capability stays reachable from somewhere.
4. **`RegulatorsPage.tsx`** — unchanged: an honestly, previously self-disclosed deliberate scope
   decision, not a hidden gap.

Removed from this list, now resolved: `PeopleAccessPage.tsx`, `ResponsesPage.tsx`, and
`UnfinishedPage.tsx`'s mockup defects (all three above).

## Firm Portal Rebuild — Real Coordinator Authentication (a dedicated remediation, not part of the sweep)

Confirmed by direct product-owner sign-off as an implementation gap against already-approved,
controlled designs — **not** new scope, and materially larger than the operator-screen sweep above,
so it gets its own pass. It closes the blocker the previous section left open: `FirmPortal.tsx` was a
1,398-line, entirely local-state mockup with no real coordinator identity anywhere in the platform,
so `FirmResultsPage.tsx`'s chosen resolution (move results into the coordinator's own portal) was
undoable until this existed.

### Two premise corrections, stated plainly before anything else

1. **No artefact source file exists anywhere in this repository.** Exhaustively grepped for
   `UX-FRM-001`, `UX-FRM-007`, `UX-FRM-RES-001`, `UX-X-001`, `v14.10`, and every other artefact ID
   this task named — only this README references them, always as labels, never as a source-of-truth
   document. "Verify directly against the artefact, never infer from the current file" is only
   partially achievable as a result: copy below is carried over **verbatim** from the earlier
   prototype file wherever it doesn't conflict with a stated rule (that file's own header claimed a
   faithful v14.5 port, and its wording reads like real, deliberate design work, not placeholder
   text), and rebuilt from the real backend's own contract where the prototype's behaviour had no
   real backing at all (see the claim flow, below). This is flagged rather than silently presented as
   independently verified.
2. **The S1/S2/S3 entry point did not exist at all**, contrary to the assumption that Part 6 "should
   require no new survey-runtime work." `RespondentApp.tsx` had only a `'firm-stub'` dead end. The
   correction: the survey-**runtime** layer needed zero changes (`startJourney` was already fully
   generic — a firm seat is not a special case there), but a new, purely additive UI entry point
   (`FirmSeatEntry.tsx`) and a small, real seat-linking wiring were still required and are now built.

### Part 1 — Real coordinator authentication

Email + PIN only, never a username/password account (the one fixed design decision the engineering
requirement itself states; everything else about verification/lockout/reuse is left open and not
invented here). Design decisions, for the record:

- **argon2id** for PIN hashing, reusing `packages/auth/src/password.ts` unchanged (`hashPassword`/
  `verifyPassword`) — the exact scheme operator passwords already use.
- **A distinct JWT claim**, not a shared session shape: `SessionPayload` (operator) now carries an
  explicit `kind: 'operator'`; a new `CoordinatorSessionPayload` carries `kind: 'coordinator'` and
  resolves to `firm_coordinators.id`, **never** `users.id`. `apps/api/src/plugins/auth-plugin.ts`'s
  `authenticate` decorator now explicitly rejects a coordinator-kind token (and the new
  `authenticateCoordinator` decorator explicitly rejects an operator-kind one) — both tokens are
  signed with the same secret, so a valid signature alone was never enough; the two identity spaces
  are now structurally incapable of being confused, not just conventionally kept apart.
- **8-hour token lifetime**, matching the operator convention exactly (`sign: {expiresIn: '8h'}`,
  the same `fastifyJwt` registration).
- **Rate limiting** on `POST /portal/auth/login` reuses the identical `RATE_LIMIT_AUTH_MAX`/
  `RATE_LIMIT_AUTH_WINDOW_MS` env vars and route-level config shape as operator `/auth/login`.
- **Anti-enumeration**: `coordinatorLogin` always does real hashing work, against a dummy argon2id
  hash when no candidate coordinator exists or none has a PIN set, the same technique operator login
  already uses (always calling `verifyPassword` regardless of whether a user was found).
- **PIN rotation requires the current PIN**, per the one explicit stated rule — enforced by the
  pre-existing, already-correct `setCoordinatorPin` (unchanged), now reachable over HTTP at
  `POST /portal/auth/pin`.
- A coordinator's email is unique **per organization**, not globally (`uniq_active_coordinator_email`)
  — the schema deliberately allows the same email to coordinate more than one firm (e.g. a
  consultant). `coordinatorLogin` tries every active coordinator for that email against the supplied
  PIN rather than assuming a single match; this was originally missed and then found and fixed by
  live verification (see "Bugs found by live verification", below).

New: `packages/domain/src/coordinator-auth-service.ts` (`coordinatorLogin`, `CoordinatorAuthError`,
`InvalidCoordinatorCredentialsError`), `getActiveCoordinatorsByEmail`/`getCoordinatorPinHash` query
additions, `apps/api/src/routes/firm-coordinator-auth.ts` (`POST /portal/auth/login`,
`POST /portal/auth/pin`, `GET /portal/auth/lookup` — see Part 3).

### Part 2 — Coordinator-portal routes, reusing the existing domain services unchanged

`apps/api/src/routes/firm-coordinator-portal.ts` wraps `firm-team-service.ts` and
`firm-portal-service.ts` — both already correct, already tested — behind `authenticateCoordinator`
instead of rebuilding either. Every route is **self-scoped**: `organizationId` always comes from
`request.coordinatorSession.organizationId` (the session token), never a client-supplied parameter,
and a lead-handover's acting coordinator is always the session's own id, never a request body field.
HTTP tests assert this directly — one firm's token cannot see another firm's coordinators or land a
seat assignment outside its own organization, and a coordinator token is still refused on the
equivalent operator-only route. "Current edition" resolves the same way the existing public
journey-context and previous-editions routes already do (the open edition, else the most recent) —
a coordinator's portal has no edition picker of its own.

### Part 3 — `FirmPortal.tsx` rebuilt against the real backend

The claim flow drops the mockup's fictional manually-typed invitation code entirely: the real
`claimSpace` takes no code parameter at all, and a second claimant is simply redirected to sign in —
`AlreadyClaimedError`'s own message ("This firm already has a space. Sign in instead.") is used
**verbatim**, not paraphrased. Two small, real, necessary public endpoints back what the prototype
faked: `GET /firm/directory` (names + ids only — a stockbroking firm's name is not confidential; it
is the reason the study exists) replaces a hardcoded `FIRMS` array, and `GET /portal/auth/lookup`
(does this email belong to a sign-in-capable coordinator, without ever disclosing which firm) backs
the email-first branch the artefact's own copy already commits to.

Team, seats, and outreach are wired to Part 2's routes (real add/handover/remove, real seat
assign/replace with the real replacement-cost warning text, real per-segment outreach volumes —
`ensureOutreachLinks`/`getOutreachVolumes`, unchanged). Results call the existing, **unchanged**
coordinator-access-code route (`firm-results.ts`) with the signed-in coordinator's own `accessCode`
from a new `GET /portal/me` — no backend change there, per the explicit instruction not to touch
that route or resolve the coordinator-vs-all-three-respondents question (still open, still not
resolved here).

"Phase" (setup/running/closed) is derived from real state, not a local demo toggle — see "Bugs found
by live verification" for a correction made to that derivation mid-build.

`apps/admin/src/firm/portalModel.ts` retires `notBuiltForSeat` (a seat row now links to a real entry
point) and `DESTINATIONS.team`/`.results` (both now built into this surface — keeping either label
would be the exact same stale "owned elsewhere" defect already fixed once before, in Mission Board).

### Part 4 — Firm results wired in; `FirmResultsPage.tsx` removed

`apps/admin/src/pages/FirmResultsPage.tsx` and its "Firm results" operator admin tab are deleted
entirely. It never had a legitimate reason to sit behind operator login once the coordinator-
authenticated surface that should always have owned it actually exists.

### Part 5 — All five `ErrorState` access-failure states, live-reachable

Spread across the two new real surfaces, each with a genuine trigger, reusing the one Phase 18
component — no second implementation:

| State                  | Real trigger                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expired_link`         | An unknown seat link token, **or** a never-assigned ('empty') seat's token — both now resolve identically, a fix made after live verification found the second case fell through to a raw inline error instead (see below)                                             |
| `no_unfinished_survey` | A started seat's link revisited with no local session to resume — the same accepted limitation institutional entries already have                                                                                                                                      |
| `access_denied`        | `FirmResultsAccessError` (403) from the unchanged `firm-results.ts` route — verified via `firm-results.test.ts`'s existing "Coordinator-only access" test plus code review, since a coordinator's own normal flow cannot organically trigger it against their own firm |
| `service_unavailable`  | Any network/5xx failure loading `/portal/me` or the seat-entry context, in either surface                                                                                                                                                                              |
| `participation_closed` | A seat link opened once the edition has closed (`editionStatus !== 'open'`) and that seat was never completed                                                                                                                                                          |

### Part 6 — A real entry point for an assigned S1/S2/S3 seat

`apps/admin/src/journey/FirmSeatEntry.tsx`, reached via `/survey?firmSeat=<token>`, mirrors
`InstitutionalEntry.tsx`'s shape (a single named context, no firm-rating step) rather than
`RetailEntry.tsx`'s — `requiresConsent()` covers only S5a/S5b, not S1/S2/S3, so there is no consent
gate and, consequently, no recovery token either: the same accepted limitation institutional entries
already have (closing the browser mid-survey cannot be resumed from this same link).

A small, genuinely necessary schema addition: `seat_assignments.link_token` (migration
`20260924000000_phase25-firm-seat-link-token.js`), regenerated on every seat **assign** and every
**clear**. Without it, the seat's own stable `id` would have had to serve as the link, and a
reassigned seat's old link would keep resolving — silently letting a _replaced_ occupant land in
whatever gets assigned to that seat next, breaking the exact promise `replacementCost`'s own warning
text already makes ("Their link stops working straight away"). New domain functions
(`getSeatEntryContext`, `startSeatEntry`, `completeSeatEntry`) and a new public
`apps/api/src/routes/firm-seat-entry.ts` (`GET .../context`, `POST .../start`,
`POST .../complete`) wrap this. `RespondentApp.tsx`'s dead `'firm-stub'` screen and its `onFirmCta`
indirection are removed — `PublicLanding.tsx`'s "Firm participation" link now goes straight to
`/firm`, a real destination.

### Bugs found by live verification (not unit/HTTP-testable — needed the whole real flow)

A full live run — real browser, real dev Postgres, no mocks — through claim → sign in → reload →
assign three seats → add a second coordinator → hand over lead → reload → open a real assigned
seat's link in a **separate, unauthenticated browser context** → answer all 11 real questions of a
real S2 (Compliance) survey → submit → reload the coordinator's page → see the seat genuinely show
Complete, surfaced three genuine defects, each requiring the full real pipeline to reproduce (fixed,
each with a regression test where the layer below the UI could express it):

1. **Coordinator login picked whichever row an email resolved to first**, not necessarily the one
   whose PIN was supplied — reproducible only because the live run happened to reuse an email across
   two firms and both attempts to sign in "worked" against the wrong firm. `getCoordinatorByEmail`
   (singular) became `getActiveCoordinatorsByEmail` (plural); `coordinatorLogin` now tries every
   candidate's PIN hash rather than assuming a single match. New domain test:
   `coordinatorLogin > signs in the right coordinator when the same email is active at two different
firms`.
2. **Phase (setup vs. running) was derived from the edition's own status**, so a firm was shown
   "running" the instant the edition opened for collection, with zero of its three seats assigned —
   only visible once a real edition was already open in the seeded dev database. A firm's own setup
   progress is independent of the edition's status; phase now derives from whether all three seats
   are actually assigned (`seats.every(s => s.state !== 'empty')`), with only "closed" still tracking
   the edition directly.
3. **An unassigned ('empty') seat's link let a visitor attempt to start a survey** — only the
   backend's own state guard (`startSeatEntry` requiring `'invited'`) stopped it, surfacing as a raw
   inline error rather than the correct explanation. `FirmSeatEntry.tsx` now treats `'empty'` the
   same as an unknown token (`expired_link`) — confirmed by visiting both in a real browser and
   seeing the identical, correct "Expired continuation link" screen.

### Verification

Full suite: `pnpm test` — **52 files, 474 tests, all green** against a live Postgres (up from 47/450:
Task D adds 4 new domain/HTTP test files — `coordinator-auth-service.test.ts`,
`firm-coordinator-auth.test.ts`, `firm-coordinator-portal.test.ts`, `firm-seat-entry.test.ts`
(domain + HTTP) — plus one existing test file rewritten in place, `portalModel.test.ts`, to match the
rebuilt model). `pnpm lint`, `pnpm typecheck`, `pnpm turbo build` all clean. `pnpm audit` unchanged —
the same three pre-existing devDependency advisories (`js-yaml`, transitive via `eslint`) as every
prior phase.

Live end-to-end, real browser (`chromium`) against a freshly-seeded `cis_dev`, no mocks anywhere —
the full run described under "Bugs found by live verification" above, plus each of the three
browser-reachable `ErrorState` triggers confirmed showing the correct, real screen (`expired_link`
for both an unknown token and an empty seat; `no_unfinished_survey` for a started seat revisited),
and the results route's genuine `409 "No signed-off scoring run exists for this edition yet"`
confirmed reaching the exact contract the frontend consumes (same endpoint, same
`x-coordinator-access-code` header, the coordinator's own real access code). Full results-content
verification (indices actually rendering `you`/`industry`/`standing` values) is not separately
re-proven here — `firm-results-service.ts` and its 9 domain tests already prove that computation;
this pass proves only that the portal reaches it correctly, which is what changed.

### Running list of open items (updated)

1. **National report approval is currently unreachable end-to-end** — unchanged, out of scope.
2. **`RegulatorsPage.tsx`** — unchanged: an honestly, previously self-disclosed deliberate scope
   decision, not a hidden gap.
3. **Coordinator-vs-all-three-respondents access to firm results** — still the interim default
   (coordinator-only), explicitly not resolved by this remediation per instruction.
4. **A coordinator with no PIN set yet has no self-service recovery path.** This can only happen for
   a coordinator an OPERATOR added directly (`addCoordinator`/`createLeadCoordinator` via the
   operator-authenticated `firm-team.ts` routes never set a PIN) — a coordinator who claims their own
   space always sets one in the same action (`claimSpace` calls `setCoordinatorPin` immediately).
   Building an email-verification or magic-link subsystem to cover this narrow case was out of this
   remediation's explicit scope (auth, portal wiring, team/results/seat-entry — not a new identity-
   recovery mechanism); the portal's "email exists, no PIN" state is flagged as `'unclaimed'` from
   `/portal/auth/lookup`, same as a genuinely unrecognised email, so nobody is shown a broken control.
5. **Outreach link consumption does not exist yet** — `ensureOutreachLinks`/`getOutreachVolumes` are
   real and now wired into the portal (real per-segment tokens, real volume counts), but nothing in
   the platform increments `opens`/`starts`/`finishes` for a client who actually follows one, or
   threads the link's segment/firm into `startJourney`'s `recruitingFirmId`. This is a pre-existing
   gap this remediation did not introduce and was not asked to close (Task D's Part 6 scope was the
   S1/S2/S3 seat entry point specifically, not the client-facing outreach-link landing page) — the
   outreach numbers shown in the portal are honestly real, just honestly always zero today.

Removed from this list, now resolved: `FirmPortal.tsx` being a complete unwired mockup;
`FirmResultsPage.tsx`'s decision being made but not executed (Part 4, above, executes it).

## Outreach-Link Consumption — the Eighth Instance of the Same Defect Class

Closes the "outreach-link consumption does not exist yet" item left open above.
`incrementOutreach` (`packages/db/src/queries/outreach.ts`) had zero callers anywhere outside its own
test file — confirmed by an exhaustive grep. `createOutreachLink`/`ensureOutreachLinks`/
`getFirmOutreachBySegment` were all real and tested, but nothing in the respondent-facing entry flow
(retail or either institutional variant) ever called it. A real investor could follow a real firm's
real outreach link, complete the entire survey, and the link's opens/starts/finishes would stay at
zero permanently — the same "built and tested in isolation, never wired" defect this whole programme
has now found and fixed eight times (Mission Board, ScoresSignoffPage, NationalReportPage,
FirmReportsPage, InvitationsPage, PeopleAccessPage/ResponsesPage/UnfinishedPage, the firm portal
rebuild's coordinator auth, and now this).

**A second, compounding gap in the same feature**: the link the portal _displayed_ to a coordinator
was itself fabricated — `OutreachView` built `${editionId}-${segment}` locally instead of reading any
real `outreach_links.token`. Wiring the increment calls alone would not have been enough; the portal
had to start showing the real link too, or there would be nothing real for a respondent to follow in
the first place.

### What was wired

- **Segment → instrument mapping**, confirmed by `segmentForInstrument`
  (`packages/domain/src/funnel-service.ts`) and `packages/domain/tests/funnel-segment.test.ts`:
  `individual` → S4 (retail); `local_institutional` → I-SEC/I-NGX/I-CSCS (all three — the doc comment
  on `segmentForInstrument` is explicit that these are Nigerian bodies, hence local) **and** S5a;
  `foreign_institutional` → S5b, the only foreign-institution instrument. Note the enum spelling
  mismatch between `OutreachSegment` (`'local_institutional'`/`'foreign_institutional'`, with the
  trailing "-al") and `FunnelSegment` (`'local_institution'`/`'foreign_institution'`, without it) — no
  shared conversion existed before this fix; the wiring translates explicitly rather than assuming
  the strings line up.
- **A third confirmed gap found while mapping the above: S5b (foreign institutional) had NO real UI
  entry point at all**, anywhere — only mentioned in code comments, never reachable from any screen.
  Same defect class as the S1/S2/S3 seat entry point found in the previous remediation. Fixed
  minimally: `InstitutionalEntry.tsx` already renders any instrument code generically (its `VARIANTS`
  lookup already falls back to "Institutional questionnaire" copy for an unrecognised code — no
  invented title was needed), so this needed no new business logic, only a direct route to it,
  bypassing the I-SEC/I-NGX/I-CSCS regulator-picker nav (which doesn't apply — there is only one
  foreign instrument, not three to choose between).
- `packages/db/src/queries/outreach.ts`: new `getOutreachLinkByToken` — the one new query function
  this fix needed (no others were added; `incrementOutreach`'s signature is unchanged).
- `packages/domain/src/firm-portal-service.ts`: `resolveOutreachToken` (returns exactly
  `{editionId, organizationId, segment}` — never counts, never the token itself, never anything
  respondent-related), `recordOutreachEvent` (a thin, unchanged wrapper over `incrementOutreach`,
  silently no-opping on an unknown token — best-effort telemetry on a navigation that has already
  happened, never a gate on it), `listOutreachLinksForFirm` (the firm's own coordinator-authenticated
  read of its own links, **with** their real tokens).
- `apps/api/src/routes/outreach-entry.ts` (new, public): `GET /outreach/:token/context`,
  `POST /outreach/:token/event`. `GET /portal/outreach` now returns real per-segment tokens (via
  `listOutreachLinksForFirm`) instead of counts alone, so the coordinator's displayed link is the one
  a respondent following it actually reaches.
- `apps/admin/src/journey/RespondentApp.tsx`: `?ref=<token>` resolves via the new context route,
  fires a real `'opens'` event, and routes to the matching entry screen by segment. `'starts'` fires
  the instant a respondent record is actually created (mirroring exactly how the seat entry point
  already records its own `'started'` transition); `'finishes'` fires on real submission, mirroring
  the existing `firmSeatLinkToken` → `firmSeatComplete` pattern exactly. An unknown or stale `ref` is
  never a gate — on failure it falls straight through to the ordinary landing page, matching the
  outreach copy's own pre-existing promise ("the link is a convenience and a measure, not a gate").

### A real privacy decision made along the way, not silently defaulted

`recruitingFirmId` is deliberately left `null` for a retail/institutional respondent recruited via an
outreach link — this was the one place where "just wire it" would have been wrong. `startJourney`
already accepts `recruitingFirmId`, and setting it to the outreach link's `organizationId` looked like
the obvious move. But `getFirmRespondentStatuses` (`packages/db/src/queries/responses.ts`, the
"respondent completion STATUS only" accessor `firm-team.ts`'s `/respondent-status` route already
exposes) reads that SAME column, filtered by organization — it was built for a firm to see its own
**named** S1/S2/S3 seat holders, people the firm itself typed the name and email for. Reusing it for
an anonymous outreach-recruited client would have surfaced that client's individual respondent id and
submission status to the firm — precisely the "no invitation count, no client list, counts only"
guarantee this whole feature exists to protect. So it is not wired: only the volume counters are.

### Verification

Full suite: `pnpm test` — **53 files, 485 tests, all green** (up from 52/474: +6 domain tests —
`resolveOutreachToken`'s exact three-key shape, `OutreachLinkNotFoundError`, a real event sequence
incrementing only its own segment, an unknown token no-oping silently, the firm's own token read
matching what the public route resolves, and — structurally — that `outreach_links` still carries no
respondent/response column after a real event; +5 HTTP tests for the new routes and the changed
`GET /portal/outreach` contract). `pnpm lint`, `pnpm typecheck`, `pnpm turbo build` all clean.
`pnpm audit` unchanged — the same three pre-existing devDependency advisories as every prior phase.

Live end-to-end, real browser, freshly-seeded `cis_dev`, no mocks: claimed a firm, assigned all three
seats to unlock outreach, opened the "Invite your clients" view and read the **real** link shown for
each of the three segments (not a fabricated one) straight out of the actual email/text templates.
In three separate, unauthenticated browser contexts:

- **Individual investors** (retail, S4): opened the real link, picked a firm to rate, answered all 14
  real survey items (including a comparison grid and a "select up to 3, then rank the greatest"
  compound control), submitted. Opens/starts/finishes: **1/1/1**.
- **Nigerian institutions** (local institutional, routed to I-SEC by default): opened the real link,
  entered an institution name, answered the full real survey, submitted. Opens/starts/finishes:
  **1/1/1**.
- **Institutions abroad** (foreign institutional, S5b — the newly-built entry point): opened the real
  link and started a real journey, deliberately left unsubmitted to prove opens/starts increment
  independently of finishes. Opens/starts/finishes: **1/1/0**.

The coordinator then reloaded the whole outreach page from scratch (not just re-read in-memory state)
and the link-performance table showed exactly these numbers, read straight from the database via
`getOutreachVolumes` — proof the counts are genuinely persisted, not client-side arithmetic.
