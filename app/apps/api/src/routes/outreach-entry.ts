import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import { resolveOutreachToken, recordOutreachEvent } from '@cis/domain';

/**
 * The public, respondent-facing side of a firm's outreach link — the other
 * half of `ensureOutreachLinks`/`getOutreachVolumes` (which create and read
 * links, but until now nothing ever consumed one). Same trust model as every
 * other entry point: the token in the URL is the only credential, and it
 * resolves to which edition/firm/segment the link belongs to — never to any
 * respondent, and never to the link's own counts (those stay a firm-facing-
 * only read, at `GET /portal/outreach`).
 */
export const outreachEntryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/outreach/:token/context',
    { schema: { params: z.object({ token: z.string().uuid() }) } },
    async (request, reply) => {
      const context = await resolveOutreachToken(getPool(), request.params.token);
      return reply.send(context);
    },
  );

  // Best-effort telemetry, never a gate: an unknown or stale token is
  // silently ignored rather than surfaced as an error to interrupt the
  // respondent's own navigation, which has already happened either way.
  app.post(
    '/outreach/:token/event',
    {
      schema: {
        params: z.object({ token: z.string().uuid() }),
        body: z.object({ event: z.enum(['opens', 'starts', 'finishes']) }),
      },
    },
    async (request, reply) => {
      await recordOutreachEvent(getPool(), request.params.token, request.body.event);
      return reply.send({ ok: true });
    },
  );
};
