import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getPool } from '@cis/db';
import { listInstitutionRoster } from '@cis/domain';
import { loadRbacContext, requirePermission } from '@cis/auth';
import { REGS_PERMISSION } from './regs-permission';

/**
 * Phase 19 — read-only institution roster: every (institution, family) role
 * that exists, independent of any edition. Used by surfaces that need the
 * full picker (e.g. showing CSCS once under Family C and once under Family D).
 */
export const institutionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/institutions', { preHandler: [app.authenticate] }, async (request, reply) => {
    // A market-institution surface: the "Market institutions" right (BUG-01).
    requirePermission(await loadRbacContext(getPool(), request.session.sub), REGS_PERMISSION);
    const roster = await listInstitutionRoster(getPool());
    return reply.send({
      institutions: roster.map((r) => ({
        id: r.id,
        name: r.name,
        isActive: r.isActive,
        familyCode: r.familyCode,
        instrumentCode: r.instrumentCode,
      })),
    });
  });
};
