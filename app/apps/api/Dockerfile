# syntax=docker/dockerfile:1.7


ARG NODE_IMAGE=node:22-trixie-slim
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
# manifests — only lockfile + package.json files, so dependency layers are
# cached until a manifest actually changes. Every workspace manifest is needed
# for --frozen-lockfile; keep this list in sync with apps/admin/Dockerfile.
# The root `prepare` script (husky) is a developer git hook and is stripped.
# ──────────────────────────────────────────────────────────────────────────────
FROM base AS manifests
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

# ──────────────────────────────────────────────────────────────────────────────
# build — full install (dev deps included), then compile the API and the
# workspace packages it depends on (turbo builds dependencies first).
# ──────────────────────────────────────────────────────────────────────────────
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm exec turbo run build --filter=@cis/api

# ──────────────────────────────────────────────────────────────────────────────
# api-bundle — production-only dependencies for @cis/api and its workspace
# packages, plus their compiled dist/ output.
# ──────────────────────────────────────────────────────────────────────────────
FROM manifests AS api-bundle
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@cis/api..."
COPY --from=build /app/apps/api/dist              apps/api/dist
COPY --from=build /app/packages/audit/dist        packages/audit/dist
COPY --from=build /app/packages/auth/dist         packages/auth/dist
COPY --from=build /app/packages/db/dist           packages/db/dist
COPY --from=build /app/packages/domain/dist       packages/domain/dist
COPY --from=build /app/packages/shared-types/dist packages/shared-types/dist
COPY --from=build /app/packages/survey/dist       packages/survey/dist

# ──────────────────────────────────────────────────────────────────────────────
# migrate-bundle — @cis/db with node-pg-migrate (a devDependency) and the
# migration files. Migrations are plain JS and need no build.
# ──────────────────────────────────────────────────────────────────────────────
FROM manifests AS migrate-bundle
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@cis/db"
COPY packages/db/migrations packages/db/migrations

# ──────────────────────────────────────────────────────────────────────────────
# runtime-base — the Node base with package managers removed. Nothing at
# runtime installs packages, so npm/npx/corepack/yarn are dead weight and a
# recurring source of CVEs.
# ──────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime-base
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production
WORKDIR /app

# ──────────────────────────────────────────────────────────────────────────────
# migrate — run once per release:  docker run --rm -e DATABASE_URL=... cis-migrate
# ──────────────────────────────────────────────────────────────────────────────
FROM runtime-base AS migrate
# Code is owned by root and read-only to the runtime user.
COPY --from=migrate-bundle /app /app
WORKDIR /app/packages/db
USER 1000:1000
CMD ["./node_modules/.bin/node-pg-migrate", "up", "--migrations-dir", "migrations", "--database-url-var", "DATABASE_URL"]

# ──────────────────────────────────────────────────────────────────────────────
# api — the default target (last stage).
# tini is PID 1: it forwards SIGTERM to node (which, as PID 1, would ignore it)
# and reaps the Chromium child processes spawned for PDF rendering.
# Build with --build-arg INSTALL_CHROMIUM=false to drop PDF support and
# roughly 400 MB of attack surface.
# ──────────────────────────────────────────────────────────────────────────────
FROM runtime-base AS api
ARG INSTALL_CHROMIUM=true
RUN set -eux; \
    pkgs="tini ca-certificates"; \
    if [ "$INSTALL_CHROMIUM" = "true" ]; then pkgs="$pkgs chromium fonts-liberation"; fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends $pkgs; \
    rm -rf /var/lib/apt/lists/*
ENV HOST=0.0.0.0 \
    PORT=3000
# Code is owned by root and read-only to the runtime user.
COPY --from=api-bundle /app /app
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
