import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool, getAllConfig, setConfig } from '@cis/db';

/**
 * Governed content / parameter administration. Consent copy (PROVISIONAL,
 * OPEN-003), the recovery-link TTL, and the public results-section flag are all
 * data, not code — an operator can read and swap them here without a deploy.
 * Operator-authenticated. (The public consent-copy read is on the journey
 * routes, since respondents must fetch it without an account.)
 */
export const governedContentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/governed-config', { preHandler: [app.authenticate] }, async (_request, reply) => {
    const config = await getAllConfig(getPool());
    return reply.send({ config });
  });

  app.put(
    '/governed-config/:key',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ key: z.string().min(1) }),
        body: z.object({ value: z.unknown(), description: z.string().optional() }),
      },
    },
    async (request, reply) => {
      await setConfig(getPool(), request.params.key, request.body.value, request.body.description);
      return reply.send({ key: request.params.key, updated: true });
    },
  );
};
