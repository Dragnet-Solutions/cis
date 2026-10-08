import type { FastifyReply } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getPool,
  getEditionById,
  getUserById,
  getEditionInstrumentViews,
  isEditionInstrumentSetFrozen,
  getPendingCriticalActionForEdition,
  listDrgOpsQuestionSummary,
  getInstrumentItems,
} from '@cis/db';
import { loadRbacContext } from '@cis/auth';
import { requestFreeze, decideFreeze, INSTRUMENT_FREEZE_ACTION } from '@cis/domain';
import type { CriticalAction } from '@cis/shared-types';

const PendingActionSchema = z
  .object({
    id: z.string().uuid(),
    reason: z.string(),
    requestedAt: z.string(),
    requestedBy: z.object({
      id: z.string().uuid(),
      displayName: z.string(),
      org: z.string().nullable(),
    }),
  })
  .nullable();

const InstrumentSchema = z.object({
  code: z.string(),
  name: z.string(),
  respondent: z.string().nullable(),
  feeds: z.string().nullable(),
  scored: z.boolean(),
  frozen: z.boolean(),
  questionCount: z.number().int().nullable(),
});

const InstrumentsResponse = z.object({
  frozen: z.boolean(),
  pendingFreeze: PendingActionSchema,
  instruments: z.array(InstrumentSchema),
  drgOps: z.array(
    z.object({
      questionCode: z.string(),
      instrumentCode: z.string(),
      instrumentName: z.string(),
    }),
  ),
});

const not = (reply: FastifyReply, code: number, error: string, message: string) =>
  (reply as FastifyReply).status(code).send({ error, message, statusCode: code });

async function serializePending(
  pool: ReturnType<typeof getPool>,
  action: CriticalAction | null,
): Promise<z.infer<typeof PendingActionSchema>> {
  if (!action) return null;
  const requester = await getUserById(pool, action.requestedBy);
  const reason = typeof action.payload['reason'] === 'string' ? action.payload['reason'] : '';
  return {
    id: action.id,
    reason,
    requestedAt: action.requestedAt.toISOString(),
    requestedBy: {
      id: action.requestedBy,
      displayName: requester?.displayName ?? 'Unknown',
      org: requester?.organization ?? null,
    },
  };
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asIntOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

export const instrumentRoutes: FastifyPluginAsyncZod = async (app) => {
  // The nine instruments for an edition, with scored + frozen state, plus the
  // DRG-OPS operational-question summary. Question text is NOT returned here.
  app.get(
    '/editions/:id/instruments',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: InstrumentsResponse },
      },
    },
    async (request, reply) => {
      const pool = getPool();
      const edition = await getEditionById(pool, request.params.id);
      if (!edition) return not(reply, 404, 'Not Found', 'Edition not found');

      const [views, frozen, pending, drgOps] = await Promise.all([
        getEditionInstrumentViews(pool, edition.id),
        isEditionInstrumentSetFrozen(pool, edition.id),
        getPendingCriticalActionForEdition(pool, edition.id, INSTRUMENT_FREEZE_ACTION),
        listDrgOpsQuestionSummary(pool),
      ]);

      return reply.send({
        frozen,
        pendingFreeze: await serializePending(pool, pending),
        instruments: views.map((v) => ({
          code: v.definition.code,
          name: v.definition.name,
          respondent: asStringOrNull(v.meta['respondent']),
          feeds: asStringOrNull(v.meta['feeds']),
          scored: v.definition.scored,
          frozen: v.frozen,
          questionCount: asIntOrNull(v.meta['questionCount']),
        })),
        drgOps,
      });
    },
  );

  // Full item set (SurveyItem shape) for an instrument, for the shared renderer.
  // DRG-OPS items are included — a respondent answers them, folded into the flow;
  // their exclusion applies only to public/report accessors, not this runtime.
  app.get(
    '/instruments/:code/items',
    { preHandler: [app.authenticate], schema: { params: z.object({ code: z.string().min(1) }) } },
    async (request, reply) => {
      const items = await getInstrumentItems(getPool(), request.params.code);
      if (items.length === 0) return not(reply, 404, 'Not Found', 'Instrument not found');
      return reply.send({ items });
    },
  );

  app.post(
    '/editions/:id/instruments/freeze/request',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ reason: z.string() }),
        response: { 201: z.object({ criticalActionId: z.string().uuid() }) },
      },
    },
    async (request, reply) => {
      const pool = getPool();
      const rbac = await loadRbacContext(pool, request.user.sub);
      const action = await requestFreeze(pool, rbac, request.params.id, request.body.reason, {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.status(201).send({ criticalActionId: action.id });
    },
  );

  app.post(
    '/editions/:id/instruments/freeze/:actionId/decide',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid(), actionId: z.string().uuid() }),
        body: z.object({ approved: z.boolean(), rejectionReason: z.string().optional() }),
        response: {
          200: z.object({
            status: z.enum(['approved', 'rejected']),
            frozen: z.boolean(),
          }),
        },
      },
    },
    async (request, reply) => {
      const pool = getPool();
      const rbac = await loadRbacContext(pool, request.user.sub);
      const { action, frozen } = await decideFreeze(
        pool,
        rbac,
        request.params.id,
        request.params.actionId,
        { approved: request.body.approved, rejectionReason: request.body.rejectionReason },
        { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null },
      );
      return reply.send({ status: action.status as 'approved' | 'rejected', frozen });
    },
  );
};
