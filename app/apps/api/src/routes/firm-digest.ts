import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import {
  assembleFirmDigest,
  sendFirmDigest,
  getFirmDigestSchedule,
  setFirmDigestSchedule,
} from '@cis/domain';

/**
 * UX-FRM-DIG-001 — Firm digest routes. A push summary of state the coordinator
 * can already see in the portal; the assemble/send split lets the admin
 * preview a digest before it goes out, and lets a scheduled job call the same
 * send path. Frequency/channel are governed config, not hardcoded.
 */
export const firmDigestRoutes: FastifyPluginAsyncZod = async (app) => {
  const params = z.object({ orgId: z.string().uuid(), editionId: z.string().uuid() });

  app.get(
    '/firm/:orgId/editions/:editionId/digest',
    { preHandler: [app.authenticate], schema: { params } },
    async (request, reply) => {
      const digest = await assembleFirmDigest(
        getPool(),
        request.params.editionId,
        request.params.orgId,
      );
      return reply.send({ digest });
    },
  );

  app.post(
    '/firm/:orgId/editions/:editionId/digest/send',
    { preHandler: [app.authenticate], schema: { params } },
    async (request, reply) => {
      const result = await sendFirmDigest(
        getPool(),
        request.params.editionId,
        request.params.orgId,
      );
      return reply.send(result);
    },
  );

  app.get('/firm-digest/schedule', { preHandler: [app.authenticate] }, async (_request, reply) => {
    const schedule = await getFirmDigestSchedule(getPool());
    return reply.send({ schedule });
  });

  app.put(
    '/firm-digest/schedule',
    {
      preHandler: [app.authenticate],
      schema: {
        body: z.object({ frequency: z.string().min(1), channel: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      await setFirmDigestSchedule(getPool(), request.body);
      return reply.send({ schedule: await getFirmDigestSchedule(getPool()) });
    },
  );
};
