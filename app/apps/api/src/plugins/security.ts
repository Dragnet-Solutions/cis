import { FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';

/**
 * Shared rate-limit store. With several API replicas, counters held in each
 * process's memory let a client multiply every limit (including the login
 * limit) by the replica count; Redis gives all replicas one set of counters.
 *
 * Opt-in: REDIS_URL, or REDIS_HOST (+ REDIS_PORT, REDIS_PASSWORD). With
 * neither set — local dev without Redis, tests — limits stay in memory.
 */
function createRateLimitRedis(): Redis | null {
  const url = process.env['REDIS_URL'];
  const host = process.env['REDIS_HOST'];
  if (!url && !host) return null;

  // Fail fast: a slow or absent Redis must not stall requests. Rate limiting
  // is skipped while it is unreachable (skipOnError below) and resumes when
  // it reconnects.
  const options = {
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
  };
  if (url) return new Redis(url, options);
  return new Redis({
    ...options,
    host,
    port: Number(process.env['REDIS_PORT'] ?? 6379),
    ...(process.env['REDIS_PASSWORD'] ? { password: process.env['REDIS_PASSWORD'] } : {}),
  });
}

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: true,
    crossOriginOpenerPolicy: true,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    xContentTypeOptions: true,
    xFrameOptions: { action: 'deny' },
  });

  const redis = createRateLimitRedis();
  if (redis) {
    // Without a listener, ioredis reports every failed reconnect as an
    // unhandled 'error' event.
    redis.on('error', (err) => app.log.warn({ err }, 'rate-limit Redis unavailable'));
    app.addHook('onClose', async () => {
      await redis.quit().catch(() => redis.disconnect());
    });
  }

  await app.register(fastifyRateLimit, {
    global: true,
    max: 1000,
    timeWindow: 60_000,
    ...(redis ? { redis, nameSpace: 'cis-ratelimit-', skipOnError: true } : {}),
    errorResponseBuilder: (_req, context) => ({
      error: 'TooManyRequests',
      message: `Rate limit exceeded. Try again in ${context.after}.`,
      statusCode: 429,
    }),
  });
}
