/**
 * Parse TRUST_PROXY into Fastify's `trustProxy` option, which decides whether
 * `request.ip` (and so every per-IP rate limit) is read from X-Forwarded-For.
 *
 *   unset / '' / 'false'  → false — the socket address (local dev, no proxy)
 *   'true'                → trust every hop (only safe if nothing upstream
 *                           passes a client-supplied X-Forwarded-For through)
 *   '2'                   → trust exactly that many proxy hops — in the
 *                           cluster: ingress-nginx → cis-admin nginx → API
 *   '10.0.0.0/8,…'        → trust only these addresses / CIDRs
 *
 * Trusting too many hops lets a client spoof its IP via X-Forwarded-For;
 * trusting too few makes every request look like it came from the proxy.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string[] {
  const raw = value?.trim() ?? '';
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
