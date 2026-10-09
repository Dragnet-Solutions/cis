import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import { getSeatEntryContext, startSeatEntry, completeSeatEntry } from '@cis/domain';

/**
 * The real entry point for an assigned S1/S2/S3 firm seat — Task D, Part 6.
 * PUBLIC, the same trust model as the retail/institutional entry points: the
 * link itself is the credential, not an account. Identified by the seat's
 * `linkToken`, never its own stable id (see the Phase 25 migration) — a
 * stale link, from before a reassignment, resolves to nothing.
 *
 * Starting a seat's survey is just the existing generic `startJourney` plus
 * recording which seat it belongs to; nothing here is a special case at the
 * survey-runtime layer.
 */
export const firmSeatEntryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/firm-seats/:linkToken/context',
    { schema: { params: z.object({ linkToken: z.string().uuid() }) } },
    async (request, reply) => {
      const context = await getSeatEntryContext(getPool(), request.params.linkToken);
      return reply.send(context);
    },
  );

  app.post(
    '/firm-seats/:linkToken/start',
    { schema: { params: z.object({ linkToken: z.string().uuid() }) } },
    async (request, reply) => {
      const result = await startSeatEntry(getPool(), request.params.linkToken);
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/firm-seats/:linkToken/complete',
    { schema: { params: z.object({ linkToken: z.string().uuid() }) } },
    async (request, reply) => {
      await completeSeatEntry(getPool(), request.params.linkToken);
      return reply.send({ ok: true });
    },
  );
};
