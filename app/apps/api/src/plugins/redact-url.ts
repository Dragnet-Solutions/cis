import type { FastifyRequest } from 'fastify';

/**
 * Secrets that travel in a URL path must not reach the logs. The set-password
 * link's token is looked up with GET /auth/password-set/:token, so the request
 * log line would otherwise carry a working credential.
 */
const SECRET_PATHS: RegExp[] = [/(\/auth\/password-set\/)[^/?#]+/];

export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  let out = url;
  for (const re of SECRET_PATHS) out = out.replace(re, '$1[REDACTED]');
  // A `token=` query parameter, wherever it appears.
  return out.replace(/([?&]token=)[^&#]*/gi, '$1[REDACTED]');
}

/** Fastify's request serializer, with secret-bearing URLs redacted. */
export function serializeRequest(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    hostname: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
