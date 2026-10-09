import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getPool } from '@cis/db';
import { listInstitutionRoster } from '@cis/domain';

/**
 * Phase 19 — read-only institution roster: every (institution, family) role
 * that exists, independent of any edition. Used by surfaces that need the
 * full picker (e.g. showing CSCS once under Family C and once under Family D).
 */
export const institutionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/institutions', { preHandler: [app.authenticate] }, async (_request, reply) => {
    const roster = await listInstitutionRoster(getPool());
    return reply.send({
      institutions: roster.map((r) => ({
        id: r.id,
        name: r.name,
        isActive: r.isActive,
        familyCode: r.familyCode,
      })),
    });
  });
};
