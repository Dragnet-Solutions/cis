import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool, listEditions } from '@cis/db';
import { getPublicContent, listPreviousPublishedEditions } from '@cis/domain';

/**
 * UX-X-002 (help, privacy, about) and UX-PUB-002 (previous editions). Both are
 * PUBLIC — a participant or a curious visitor has no account. Nothing here
 * hardcodes wording; UX-X-002's four sections are read live from Phase 15's
 * managed-content system. "Current edition" resolves the same way the journey
 * context route does: the open one, else the most recent.
 */
export const publicContentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/public-content', async (_request, reply) => {
    const content = await getPublicContent(getPool());
    return reply.send(content);
  });

  app.get(
    '/public-content/previous-editions',
    { schema: { querystring: z.object({ currentEditionId: z.string().uuid().optional() }) } },
    async (request, reply) => {
      const pool = getPool();
      let currentEditionId = request.query.currentEditionId ?? null;
      if (!currentEditionId) {
        const editions = await listEditions(pool);
        const current = editions.find((e) => e.status === 'open') ?? editions[0] ?? null;
        currentEditionId = current?.id ?? null;
      }
      const editions = await listPreviousPublishedEditions(pool, currentEditionId);
      return reply.send({ editions });
    },
  );
};
