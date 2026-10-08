# K8s Manifest

Raw (non-Kustomize) manifests for CIS × Dragnet, organized the same way every other app in the
org's shared AKS `dev` namespace is: one directory per component, ArgoCD `sync-wave` annotations
for ordering, secrets from Azure Key Vault via External Secrets — never a plain committed `Secret`.

## Layout
| Directory | What it deploys |
|---|---|
| `api/` | `cis-api` Deployment (Fastify API + headless Chromium for PDF export, non-root uid 1000), Service, HPA, PDB, ServiceAccount, and the one-shot `cis-db-migration` Job (`cis-api-migrate` image, `node-pg-migrate up`) |
| `admin/` | `cis-admin` Deployment (React SPA on unprivileged nginx, uid 101), Service, HPA, PDB, ServiceAccount, and the Ingress for the whole app |
| `redis/` | Dedicated in-cluster Redis StatefulSet (`cis-redis`, password-protected, 2Gi `managed-csi` volume) + headless and ClusterIP Services — not shared with any other app in the namespace |
| `config/` | `cis-api-config` and `cis-admin-config` ConfigMaps (non-secret env) |
| `eso/` | `ExternalSecret` pulling the API's secrets from Azure Key Vault into `cis-api-secrets` — the admin has no secrets |
| `network-policy/` | Ingress/egress rules scoped to this app; assumes the namespace's default-deny/DNS baseline already exists |

ArgoCD's `Application` (see `../argocd`) applies this whole tree with `directory.recurse: true`.

## Traffic
- **Browser → ingress → `cis-admin`** for everything. Its nginx serves the SPA (`/`, `/firm`,
  `/survey`, `/print/*`) and proxies `/api/*` to `cis-api` with the `/api` prefix stripped, so the
  browser sees a single origin (the API has no CORS).
- **`cis-api` → `cis-admin`** for PDF export: the API's headless Chromium opens
  `REPORT_RENDER_URL` (`http://cis-admin`) `/print/*`, and that page calls `/api` back through
  `cis-admin`. The network policies allow both directions.
- **`cis-api` / migration → Postgres** (Azure Flexible Server, external), plus HTTPS/SMTP for Azure
  AI Foundry and ZeptoMail.
- **`cis-api` → `cis-redis`** (in-cluster). Only `cis-api` pods may reach it.

## Sync-wave order
0. ServiceAccounts, ConfigMaps, ExternalSecret, NetworkPolicies
1. Redis StatefulSet + Services
2. DB migration Job (ArgoCD `Sync` hook — self-deletes and recreates every release), Services, PDBs
3. `cis-api`, `cis-admin` Deployments
4. HPAs, Ingress

## Before first sync (assumptions this makes)
- **Images**: `dragnet.azurecr.io/cis-api`, `cis-api-migrate` (both from `app/apps/api/Dockerfile`,
  targets `api` / `migrate`) and `cis-admin` (from `app/apps/admin/Dockerfile`).
- **Namespace prerequisites**: the shared `dev` namespace must already have the baseline
  default-deny/DNS-egress/ingress-nginx NetworkPolicies and an `azure-keyvault-store`
  `SecretStore` — this app does not create them.
- **Placeholders to replace**:
  - `dev-cis.example.com` in `admin/ingress.yaml` and `PORTAL_URL` in `config/api-configmap.yaml`
  - `DB_HOST` in `config/api-configmap.yaml` — the real Flexible Server FQDN
  - `MAIL_FROM` in `config/api-configmap.yaml`
- **Key Vault secrets** (see `eso/external-secret.yaml`): `cis-dev-DATABASE-URL` (include
  `?sslmode=require`), `cis-dev-JWT-SECRET`, `cis-dev-REDIS-PASSWORD`, `cis-dev-AZURE-AI-API-KEY`, `cis-dev-SMTP-URL`,
  `cis-dev-ZEPTOMAIL-API-TOKEN`, and `cis-argocd-deploy-key` for ArgoCD's repo access.
- **Postgres**: the first migration runs `CREATE EXTENSION pgcrypto` — allow-list `PGCRYPTO` in the
  Flexible Server's `azure.extensions` parameter first.
- **CI/CD**: `.github/workflows/api-CI.yaml` and `admin-CI.yaml` build/scan/sign/push each image on
  every push to `dev` and pin the new SHA into these manifests on the `k8s-release` branch (the
  branch ArgoCD actually syncs from — see `../argocd/application.yaml`). Editing an `image:` line
  directly in this tree only matters as the un-pinned default on `dev`; the running cluster always
  tracks whatever SHA the pipeline last pinned on `k8s-release`.

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
