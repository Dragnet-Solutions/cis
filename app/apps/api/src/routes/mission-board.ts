import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import { getMissionBoard, ingestZeptomailEvent } from '@cis/domain';

/**
 * Mission board routes — UX-OPS-001. The board is evaluated live at an
 * evaluation instant (`asOf`, injectable so an operator can preview; production
 * runs hourly), and carries the Zeptomail delivery webhook. The
 * institution-engagement reads/writes now live on the UX-OPS-007 regulator
 * routes (`regulators.ts`) — a lead time is only ever set via the gated
 * issue-link flow, never a raw setter.
 */
export const missionBoardRoutes: FastifyPluginAsyncZod = async (app) => {
  const editionParam = z.object({ id: z.string().uuid() });

  app.get(
    '/editions/:id/mission-board',
    {
      preHandler: [app.authenticate],
      schema: {
        params: editionParam,
        querystring: z.object({ asOf: z.string().datetime().optional() }),
      },
    },
    async (request, reply) => {
      const asOf = request.query.asOf ? new Date(request.query.asOf) : new Date();
      const board = await getMissionBoard(getPool(), request.params.id, asOf);
      return reply.send(board);
    },
  );

  // Zeptomail delivery webhook (delivered/bounced/opened/clicked). No auth
  // decorator — a real deployment verifies the provider's signature instead;
  // here it maps the event onto the matching recipient.
  app.post(
    '/invitations/zeptomail-webhook',
    {
      schema: {
        body: z.object({
          batchId: z.string().uuid(),
          recipientEmail: z.string(),
          event: z.enum(['email.delivered', 'email.bounced', 'email.opened', 'email.clicked']),
          at: z.string().datetime().optional(),
        }),
      },
    },
    async (request, reply) => {
      const matched = await ingestZeptomailEvent(getPool(), {
        batchId: request.body.batchId,
        recipientEmail: request.body.recipientEmail,
        event: request.body.event,
        ...(request.body.at ? { at: new Date(request.body.at) } : {}),
      });
      return reply.send({ matched });
    },
  );
};
