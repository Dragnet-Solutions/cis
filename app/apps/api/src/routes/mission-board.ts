import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  getMissionBoard,
  ingestZeptomailEvent,
  ingestOutboxDeliveryEvent,
  type OutboxDeliveryEvent,
} from '@cis/domain';

/** ZeptoMail webhook event names we act on (a soft bounce is retried by
 *  ZeptoMail itself, so it changes nothing here). */
const ZEPTO_EVENTS: Record<string, OutboxDeliveryEvent> = {
  hardbounce: 'bounced',
  email_open: 'opened',
  email_link_click: 'clicked',
};

/** One invitation-batch recipient's event (the original, hand-made shape). */
const LegacyWebhookBody = z.object({
  batchId: z.string().uuid(),
  recipientEmail: z.string(),
  event: z.enum(['email.delivered', 'email.bounced', 'email.opened', 'email.clicked']),
  at: z.string().datetime().optional(),
});

/** ZeptoMail's webhook payload (only the fields used here). */
const ZeptoWebhookBody = z
  .object({
    event_name: z.union([z.string(), z.array(z.string())]),
    event_message: z.array(
      z
        .object({
          email_info: z
            .object({ client_reference: z.string().optional() })
            .passthrough()
            .optional(),
          event_data: z.array(z.unknown()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Constant-time comparison of the presented webhook secret. */
function secretMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The bounce reason ZeptoMail reports, if any (kept short). */
function bounceReason(msg: { event_data?: unknown[] | undefined }): string | null {
  const first = msg.event_data?.[0] as { details?: Array<{ reason?: unknown }> } | undefined;
  const reason = first?.details?.[0]?.reason;
  return typeof reason === 'string' ? reason.slice(0, 200) : null;
}

/**
 * Mission board routes — UX-OPS-001. The board is evaluated live at an
 * evaluation instant (`asOf`, injectable so an operator can preview; production
 * runs hourly), and carries the ZeptoMail delivery webhook. The
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

  // ZeptoMail delivery webhook. Protected by a shared secret
  // (ZEPTOMAIL_WEBHOOK_SECRET), sent as the `x-cis-webhook-secret` header or a
  // `?secret=` query parameter (configure the webhook URL in ZeptoMail with
  // it); refused when the secret is unset or does not match. Two body shapes:
  //  - ZeptoMail's own payload (event_name / event_message[].email_info
  //    .client_reference = the outbox email id the dispatcher sent): a
  //    hardbounce marks the email failed (and its invitation recipient
  //    bounced); email_open / email_link_click record opens and clicks.
  //  - { batchId, recipientEmail, event } for one invitation-batch recipient.
  app.post(
    '/invitations/zeptomail-webhook',
    {
      // The secret is checked before the body is validated, so a caller
      // without it learns nothing about the expected payload.
      preValidation: async (request, reply) => {
        const expected = process.env['ZEPTOMAIL_WEBHOOK_SECRET']?.trim();
        if (!expected) {
          return reply.status(503).send({
            statusCode: 503,
            error: 'Service Unavailable',
            message: 'The delivery webhook is not configured',
          });
        }
        const header = request.headers['x-cis-webhook-secret'];
        const given =
          (Array.isArray(header) ? header[0] : header) ??
          (request.query as { secret?: string } | undefined)?.secret ??
          '';
        if (!secretMatches(given, expected)) {
          return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Invalid webhook secret',
          });
        }
      },
      schema: {
        querystring: z.object({ secret: z.string().optional() }).passthrough(),
        body: z.union([LegacyWebhookBody, ZeptoWebhookBody]),
      },
    },
    async (request, reply) => {
      const legacy = LegacyWebhookBody.safeParse(request.body);
      if (legacy.success) {
        const body = legacy.data;
        const matched = await ingestZeptomailEvent(getPool(), {
          batchId: body.batchId,
          recipientEmail: body.recipientEmail,
          event: body.event,
          ...(body.at ? { at: new Date(body.at) } : {}),
        });
        return reply.send({ matched });
      }

      const body = ZeptoWebhookBody.parse(request.body);
      const names = Array.isArray(body.event_name) ? body.event_name : [body.event_name];
      let matched = 0;
      for (const [i, msg] of body.event_message.entries()) {
        const event = ZEPTO_EVENTS[names[i] ?? names[0] ?? ''];
        const reference = msg.email_info?.client_reference;
        if (!event || !reference) continue;
        if (
          await ingestOutboxDeliveryEvent(getPool(), {
            reference,
            event,
            detail: bounceReason(msg),
          })
        ) {
          matched += 1;
        }
      }
      return reply.send({ matched: matched > 0, events: matched });
    },
  );
};
