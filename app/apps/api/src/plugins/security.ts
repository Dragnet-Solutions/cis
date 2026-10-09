import { FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';

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

  await app.register(fastifyRateLimit, {
    global: true,
    max: 1000,
    timeWindow: 60_000,
    errorResponseBuilder: (_req, context) => ({
      error: 'TooManyRequests',
      message: `Rate limit exceeded. Try again in ${context.after}.`,
      statusCode: 429,
    }),
  });
}
