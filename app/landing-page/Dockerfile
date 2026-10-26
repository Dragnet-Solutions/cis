# syntax=docker/dockerfile:1.7

ARG ALPINE_IMAGE=alpine:3.22
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine

# ──────────────────────────────────────────────────────────────────────────────
# build
# ──────────────────────────────────────────────────────────────────────────────
FROM ${ALPINE_IMAGE} AS build
WORKDIR /site
COPY cisdragnetstudy/ ./
RUN set -eux; \
    find . -type d -exec chmod 0755 {} +; \
    find . -type f -exec chmod 0644 {} +; \
    find . -type f \( -name '*.html' -o -name '*.css' -o -name '*.txt' \
                      -o -name '*.xml' -o -name '*.webmanifest' -o -name '*.ico' \) \
         -exec sh -c 'for f; do gzip -9 -n -c "$f" > "$f.gz"; done' sh {} +

# ──────────────────────────────────────────────────────────────────────────────
# landing — runtime.
# ──────────────────────────────────────────────────────────────────────────────
FROM ${NGINX_IMAGE} AS landing
ARG GIT_COMMIT=""
ARG BUILD_TIME=""
LABEL org.opencontainers.image.title="cis-landing" \
      org.opencontainers.image.description="CIS - Dragnet Study landing page (cisdragnetstudy.com)" \
      org.opencontainers.image.source="https://github.com/Dragnet-Solutions/cis" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIME}"
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site /var/www/cisdragnetstudy
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
