# K8s Manifest

Raw (non-Kustomize) manifests for the CIS - Dragnet Study, organized the same way every other app in the
org's shared AKS `dev` namespace is: one directory per component, ArgoCD `sync-wave` annotations
for ordering, secrets from Azure Key Vault via External Secrets — never a plain committed `Secret`.

## Layout
| Directory | What it deploys |
|---|---|
| `api/` | `cis-api` Deployment (Fastify API + headless Chromium for PDF export, non-root uid 1000), Service, HPA, PDB, ServiceAccount, the one-shot `cis-db-migration` Job (`cis-api-migrate` image, `node-pg-migrate up`) and — **dev only** — the `cis-db-seed` Job (reference data + operator passwords) |
| `admin/` | `cis-admin` Deployment (React SPA on unprivileged nginx, uid 101), Service, HPA, PDB, ServiceAccount, and the Ingress for the whole app |
| `landing/` | `cis-landing` Deployment (the static cisdragnetstudy.com marketing site on unprivileged nginx, uid 101, from `app/landing-page/Dockerfile`), Service, HPA, PDB, ServiceAccount, and its own Ingress for `cisdragnetstudy.com` + `www` |
| `redis/` | Dedicated in-cluster Redis StatefulSet (`cis-redis`, password-protected, 2Gi `managed-csi` volume) + headless and ClusterIP Services — not shared with any other app in the namespace |
| `config/` | `cis-api-config` and `cis-admin-config` ConfigMaps (non-secret env) |
| `eso/` | `ExternalSecret`s pulling from Azure Key Vault: the API's secrets into `cis-api-secrets`, and — **dev only** — the seeded operators' passwords into `cis-seed-secrets` (read only by the seed Job). The admin has no secrets |
| `network-policy/` | Ingress/egress rules scoped to this app; assumes the namespace's default-deny/DNS baseline already exists |

ArgoCD's `Application` (see `../argocd`) applies this whole tree with `directory.recurse: true`.

## Traffic
- **Browser → ingress → `cis-admin`** for everything. Its nginx serves the SPA (`/`, `/firm`,
  `/survey`, `/print/*`) and proxies `/api/*` to `cis-api` with the `/api` prefix stripped, so the
  browser sees a single origin (the API has no CORS).
- **Browser → ingress → `cis-landing`** for `cisdragnetstudy.com` (and `www`, which the landing
  image's nginx redirects to the apex). It is a separate static site: it talks to nothing else
  in the cluster and nothing talks to it except the ingress.
- **`cis-api` → `cis-admin`** for PDF export: the API's headless Chromium opens
  `REPORT_RENDER_URL` (`http://cis-admin`) `/print/*`, and that page calls `/api` back through
  `cis-admin`. The network policies allow both directions.
- **`cis-api` / migration → Postgres** (Azure Flexible Server, external), plus HTTPS/SMTP for Azure
  AI Foundry and ZeptoMail.
- **`cis-api` → `cis-redis`** (in-cluster). Only `cis-api` pods may reach it.

## Security headers (Content-Security-Policy)
The application sets its own CSP; the Ingress adds none, and should not. Two policies:

- **The SPA** (`cis-admin` nginx, `app/apps/admin/nginx/default.conf.template`, on `/` and
  `/set-password`, so every client route including `/print/*` and `/reports/*`):
  `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
  Google Fonts is the only third-party origin. The headless Chromium that prints PDFs is not
  affected (puppeteer's waits run over the DevTools protocol, outside the page's CSP).
- **The API** (helmet, `app/apps/api/src/plugins/security.ts`, on every `/api/*` response):
  `default-src 'none'; frame-ancestors 'none'`.

Do not add a CSP at the Ingress (`nginx.ingress.kubernetes.io/configuration-snippet` /
`more_set_headers`): a second `Content-Security-Policy` header does not replace the app's, the
browser enforces both, so an ingress policy can only tighten it and will silently break the app if
it disagrees (for example, by omitting Google Fonts). If the page ever loads a new origin, change
the nginx template.

## Sync-wave order
0. ServiceAccounts, ConfigMaps, ExternalSecret, NetworkPolicies
1. Redis StatefulSet + Services
2. DB migration Job (ArgoCD `Sync` hook — self-deletes and recreates every release), Services, PDBs
3. `cis-api`, `cis-admin`, `cis-landing` Deployments; **dev only:** `cis-db-seed` Job (ArgoCD `Sync` hook, after the migration)
4. HPAs, Ingresses

## Before first sync (assumptions this makes)
- **Images**: `dragnet.azurecr.io/cis-api`, `cis-api-migrate` (both from `app/apps/api/Dockerfile`,
  targets `api` / `migrate`), `cis-admin` (from `app/apps/admin/Dockerfile`) and `cis-landing`
  (from `app/landing-page/Dockerfile`).
- **DNS for the landing page**: an `A` record for `cisdragnetstudy.com` → the ingress-nginx
  controller's public IP (`kubectl -n ingress-nginx get svc`, the `LoadBalancer`'s
  `EXTERNAL-IP`), and a `CNAME` for `www.cisdragnetstudy.com` → `cisdragnetstudy.com`. Both must
  resolve before `landing/ingress.yaml` syncs, or cert-manager's HTTP-01 challenge for
  `cis-landing-tls` fails. The `A` record pins that IP, so it must be a static public IP: if the
  controller's Service is ever recreated with a dynamic one, the site goes dark.
- **Namespace prerequisites**: the shared `dev` namespace must already have the baseline
  default-deny/DNS-egress/ingress-nginx NetworkPolicies and an `azure-keyvault-store`
  `SecretStore` — this app does not create them.
- **Placeholders to replace**:
  - `dev-cis.example.com` in `admin/ingress.yaml` and `PORTAL_URL` in `config/api-configmap.yaml`
  - `DB_HOST` in `config/api-configmap.yaml` — the real Flexible Server FQDN
  - `MAIL_FROM` in `config/api-configmap.yaml` — an address on a domain verified in ZeptoMail
    (and `ZEPTOMAIL_API_URL` if the account is not on the default region)
- **Key Vault secrets** (see `eso/external-secret.yaml`): `cis-dev-DATABASE-URL` (include
  `?sslmode=require`), `cis-dev-JWT-SECRET`, `cis-dev-REDIS-PASSWORD`, `cis-dev-AZURE-AI-API-KEY`, `cis-dev-SMTP-URL`,
  `cis-dev-ZEPTOMAIL-API-TOKEN` (the Mail Agent's Send Mail token — the API sends notices
  through ZeptoMail when it is set, otherwise falls back to `SMTP_URL`), and `cis-argocd-deploy-key` for ArgoCD's repo access.
- **Postgres**: the first migration runs `CREATE EXTENSION pgcrypto` — allow-list `PGCRYPTO` in the
  Flexible Server's `azure.extensions` parameter first.
- **CI/CD**: `.github/workflows/api-CI.yaml`, `admin-CI.yaml` and `landing-CI.yaml` build/scan/sign/push each image on
  every push to `dev` and pin the new SHA into these manifests on the `k8s-release` branch (the
  branch ArgoCD actually syncs from — see `../argocd/application.yaml`). Editing an `image:` line
  directly in this tree only matters as the un-pinned default on `dev`; the running cluster always
  tracks whatever SHA the pipeline last pinned on `k8s-release`.

## Sender, replies and support address
- **Sender**: `MAIL_FROM` is `CIS - Dragnet Study <noreply@idhub.ng>`. The address is still on
  idhub.ng; moving it to `noreply@cisdragnetstudy.com` is a DevOps/IT task (verify the
  cisdragnetstudy.com domain in the ZeptoMail Mail Agent — SPF/DKIM — then change `MAIL_FROM`
  only). No code change is needed.
- **Replies**: every email's Reply-To is `MAIL_REPLY_TO`, set to `support@cisdragnetstudy.com`.
  If it is removed, replies still go to `SUPPORT_EMAIL` (then the built-in default,
  `support@cisdragnetstudy.com`) — never to the no-reply sender.
- **Support**: `SUPPORT_EMAIL` (`support@cisdragnetstudy.com`) is the address shown in every
  email footer and in the reports; that mailbox must exist and be monitored.

## ZeptoMail webhooks
ZeptoMail reports bounces, opens and clicks back to the API; it never reports a delivery, so the
app shows a sent email as "Accepted by ZeptoMail", not "Delivered". In the ZeptoMail Mail Agent,
add a webhook:
- **URL**: `https://dev-cis.idhub.ng/api/invitations/zeptomail-webhook`
- **Events**: hard bounce, soft bounce, open, click
- **Header**: `x-cis-webhook-secret` = the value of Key Vault secret
  `cis-dev-ZEPTOMAIL-WEBHOOK-SECRET`

The API reads it as `ZEPTOMAIL_WEBHOOK_SECRET` and refuses webhook calls without it. That
variable is **not wired yet**: once the `cis-dev-ZEPTOMAIL-WEBHOOK-SECRET` Key Vault secret
exists, add a `ZEPTOMAIL_WEBHOOK_SECRET` entry for it to `eso/external-secret.yaml` (same shape as
`ZEPTOMAIL_API_TOKEN`). Until then Setup › Mail in the admin shows "Bounce and open reports: Not
set up". The same page shows whether the API token is set at all (a red banner when notices are
only being recorded) and can send a test email.

## Background jobs in the API pods
There are no CronJobs. Each `cis-api` pod runs two in-process timers, started after it begins
listening and stopped on shutdown:

- **Mail dispatcher** — sends the email outbox every `MAIL_DISPATCH_INTERVAL_MS` (default 15s).
  Notices are leased, so several pods are safe. `MAIL_DISPATCH=off` disables it.
- **Respondent reminders** — every `REMINDER_SCHEDULE_INTERVAL_MS` (default `3600000`, one hour)
  and once `REMINDER_SCHEDULE_FIRST_RUN_MS` after start (default `60000`), it sends the reminders
  due by the governed schedule (2 and 7 days after a respondent stopped, 3 days before close, up
  to the cap) for every edition whose status is open. A Postgres advisory lock means only one pod
  runs a pass at a time, and the reminder ledger's unique (edition, response, step) means a
  reminder is never sent twice. `REMINDER_SCHEDULE=off` disables it; the Unfinished page's "Send
  reminders now" button runs the same pass on demand.

## Which build is running
CI tags every image with the commit sha and bakes the commit, image tag and build time into both
images. To state the deployed build in writing:

```sh
# What the running API reports (public, no secrets):
curl https://dev-cis.idhub.ng/api/version
# {"service":"cis-api","commit":"<full sha>","commitShort":"<7 chars>","imageTag":"<sha>","buildTime":"2026-10-22T14:05:00.000Z"}

# Cross-check against the image the Deployment actually pins (tag = commit sha):
kubectl -n dev get deploy cis-api -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl -n dev get deploy cis-admin -o jsonpath='{.spec.template.spec.containers[0].image}'
```

`imageTag` must equal the tag after `cis-api:`. The operator footer (and Setup › Mail) shows the
same, plus the admin bundle's own commit; it turns red when the admin and API images come from
different builds. `unknown` means the image was built without the build args (not by CI).

## Seeding (dev only)
Migrations only create the schema. `api/seed-job.yaml` runs `seedReferenceData`
(`apps/api/src/seed.ts`) on every sync — the 2026 edition, the Survey Register (9 instruments /
90 questions), RBAC, governed config and two operators — and skips itself once the 2026 edition
exists. It then sets both operators' passwords from Key Vault, because the seed hard-codes
`ChangeMe!2026` and the app has no change-password feature.

| Login | Key Vault secret (12+ chars) |
|---|---|
| `adaeze.okoro@cis.example` | `cis-dev-SEED-PASSWORD-MAKER` |
| `segun.oyegbesan@dragnet.example` | `cis-dev-SEED-PASSWORD-CHECKER` |

To rotate a password: change it in Key Vault, let ESO refresh (or annotate the ExternalSecret
`force-sync`), then sync. **Production must not carry `api/seed-job.yaml` or
`eso/seed-external-secret.yaml`** — real operator accounts there need a deliberate, one-off
procedure. Never run `seed-demo.ts` against a shared database.

## Known application limits that affect scaling
- **Rate limits and the PDF cache are in memory, per pod.** With more than one `cis-api` replica
  the login rate limit is effectively multiplied by the replica count. `cis-redis` is deployed
  for this, but **the API code does not use Redis yet** — `@fastify/rate-limit` still needs to be
  pointed at it (`REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` are already in its environment).
- **`TRUST_PROXY: "2"`** in `config/api-configmap.yaml` must match the real number of proxy hops
  (ingress-nginx → `cis-admin` nginx). If a hop is added or removed, update it — too few makes
  every client share one rate limit, too many lets clients spoof their IP. Note that the ingress's
  `use-forwarded-headers: "true"` also trusts a client-supplied `X-Forwarded-For` at the ingress
  itself unless ingress-nginx sits behind a load balancer that overwrites it.
