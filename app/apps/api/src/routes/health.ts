import { FastifyPluginAsync } from 'fastify';
import { getPool } from '@cis/db';

/**
 * Container probes. Both are public, unauthenticated and exempt from the
 * global rate limit (kubelet probes every pod every few seconds), and log only
 * at warn so they don't flood the request log.
 *
 *   GET /health — liveness: the process is up and serving. Never touches the
 *                 database, so a database outage doesn't restart every pod.
 *   GET /ready  — readiness: the database answers. A failing pod is taken out
 *                 of the Service until it recovers.
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  const probe = { logLevel: 'warn' as const, config: { rateLimit: false as const } };

  app.get('/health', probe, async (_request, reply) => {
    return reply.send({ status: 'ok' });
  });

  app.get('/ready', probe, async (request, reply) => {
    try {
      await getPool().query('SELECT 1');
      return reply.send({ status: 'ok' });
    } catch (err) {
      request.log.warn({ err }, 'readiness check failed: database unreachable');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });
};
