import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import { getDragnetMaturity, getDragnetFriction, getDragnetMaturityCsv } from '@cis/domain';

/**
 * Dragnet Internal Analysis routes — UX-ADM-007 (Phase 16).
 *
 * Access: requires access:dragnet (Phase 8's `dragnet` right). CIS-organisation
 * users structurally cannot hold this right. Enforced at the domain layer on
 * every request; frontend hiding is NOT the only gate.
 *
 * The join boundary is NEVER crossed here: maturity and friction are served by
 * different domain functions backed by different query paths.
 */
export const dragnetRoutes: FastifyPluginAsyncZod = async (app) => {
  const editionParam = z.object({ editionId: z.string().uuid() });

  // Firm maturity table — per-firm OMI/DMI + tier + consented contact only.
  app.get(
    '/editions/:editionId/dragnet/maturity',
    { preHandler: [app.authenticate], schema: { params: editionParam } },
    async (request, reply) => {
      const firms = await getDragnetMaturity(getPool(), request.params.editionId, request.user.sub);
      return reply.send({ firms });
    },
  );

  // CSV download — same consent boundary and query as the screen.
  app.get(
    '/editions/:editionId/dragnet/maturity.csv',
    { preHandler: [app.authenticate], schema: { params: editionParam } },
    async (request, reply) => {
      const csv = await getDragnetMaturityCsv(
        getPool(),
        request.params.editionId,
        request.user.sub,
      );
      void reply.header('Content-Type', 'text/csv; charset=utf-8');
      void reply.header('Content-Disposition', 'attachment; filename="dragnet-maturity.csv"');
      return reply.send(csv);
    },
  );

  // DRG-OPS aggregate friction — no firm identifiers, aggregate only.
  app.get(
    '/editions/:editionId/dragnet/friction',
    { preHandler: [app.authenticate], schema: { params: editionParam } },
    async (request, reply) => {
      const friction = await getDragnetFriction(
        getPool(),
        request.params.editionId,
        request.user.sub,
      );
      return reply.send({ friction });
    },
  );
};
