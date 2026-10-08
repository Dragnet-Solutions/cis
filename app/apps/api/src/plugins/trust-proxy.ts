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
export type TrustProxy = boolean | string[] | ((address: string, hop: number) => boolean);

export function parseTrustProxy(value: string | undefined): TrustProxy {
  const raw = value?.trim() ?? '';
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) {
    // A hop count, as a function: Fastify's types don't accept a bare number.
    // Hop 0 is the socket peer, so this trusts exactly `hops` proxies.
    const hops = Number(raw);
    return (_address, hop) => hop < hops;
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
