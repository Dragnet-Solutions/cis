# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-trixie-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine
ARG PNPM_VERSION=10.33.0

# ──────────────────────────────────────────────────────────────────────────────
# base — toolchain only (pnpm). Never shipped.
# ──────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    HUSKY=0 \
    TURBO_TELEMETRY_DISABLED=1
RUN npm install --global "pnpm@${PNPM_VERSION}" && npm cache clean --force
WORKDIR /app

# ──────────────────────────────────────────────────────────────────────────────
# build — install and compile. Every workspace manifest is needed for
# --frozen-lockfile; keep this list in sync with apps/api/Dockerfile.
# The root `prepare` script (husky) is a developer git hook and is stripped.
# ──────────────────────────────────────────────────────────────────────────────
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/admin/package.json            apps/admin/
COPY apps/api/package.json              apps/api/
COPY packages/audit/package.json        packages/audit/
COPY packages/auth/package.json         packages/auth/
COPY packages/db/package.json           packages/db/
COPY packages/domain/package.json       packages/domain/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/survey/package.json       packages/survey/
RUN npm pkg delete scripts.prepare
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json turbo.json ./
COPY packages/survey ./packages/survey
COPY apps/admin ./apps/admin

RUN pnpm exec turbo run build --filter=@cis/admin

# ──────────────────────────────────────────────────────────────────────────────
# admin — runtime. Only the static bundle and the nginx config are shipped.
# ──────────────────────────────────────────────────────────────────────────────
FROM ${NGINX_IMAGE} AS admin
ENV API_UPSTREAM=http://api:3000
COPY apps/admin/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
