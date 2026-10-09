import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import { getFirmResults } from '@cis/domain';

/**
 * Firm private results — UX-FRM-RES-001. A COORDINATOR-facing surface: it is not
 * operator-authenticated. The interim access default is coordinator-only (§9),
 * verified by the firm's coordinator access code carried in the
 * `x-coordinator-access-code` header; the domain service confirms the code
 * belongs to an active coordinator OF THIS FIRM. There is deliberately no
 * endpoint here that could return another firm's score, name, rank, or any
 * institutional-level result.
 */
export const firmResultsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/editions/:editionId/firms/:firmId/results',
    {
      schema: {
        params: z.object({ editionId: z.string().uuid(), firmId: z.string().uuid() }),
        headers: z.object({ 'x-coordinator-access-code': z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const results = await getFirmResults(getPool(), {
        editionId: request.params.editionId,
        firmId: request.params.firmId,
        coordinatorAccessCode: request.headers['x-coordinator-access-code'],
      });
      return reply.send(results);
    },
  );
};
