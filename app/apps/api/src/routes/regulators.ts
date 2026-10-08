import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import {
  listRegulators,
  getRegulator,
  saveContact,
  issueSurveyLink,
  sendReminder,
  sendTextReminder,
  markDeclined,
  markSubmitted,
  reopenDeclined,
  recordHistory,
} from '@cis/domain';
import { loadRbacContext } from '@cis/auth';

/**
 * Regulator engagement routes — UX-OPS-007. One record per (edition,
 * institution, family) role: the named contact, the survey link, the lead
 * time (which lands in Phase 10's institution_engagement.target_by), and an
 * append-only free-text history.
 *
 * Phase 19 re-keys the URL from a fixed `:institution` enum segment to
 * `:institutionId/:familyCode` — a multi-role institution (CSCS: Family C and
 * Family D) needs two independent routes into two independent rows.
 *
 * The contact-before-survey ordering, the terminal `declined` outcome
 * (reversible only via the access:regs-gated reopen route), and the
 * cancel-and-restart referral are all enforced in the domain service — these
 * routes are thin.
 */
export const regulatorRoutes: FastifyPluginAsyncZod = async (app) => {
  const familyCode = z.enum(['A', 'B', 'C', 'D']);
  const editionParam = z.object({ id: z.string().uuid() });
  const oneParam = z.object({
    id: z.string().uuid(),
    institutionId: z.string().uuid(),
    familyCode,
  });
  const asOfQuery = z.object({ asOf: z.string().datetime().optional() });
  const asOfOf = (q: { asOf?: string }): Date => (q.asOf ? new Date(q.asOf) : new Date());

  app.get(
    '/editions/:id/regulators',
    { preHandler: [app.authenticate], schema: { params: editionParam, querystring: asOfQuery } },
    async (request, reply) => {
      const regulators = await listRegulators(getPool(), request.params.id, asOfOf(request.query));
      return reply.send({ regulators });
    },
  );

  app.get(
    '/editions/:id/regulators/:institutionId/:familyCode',
    { preHandler: [app.authenticate], schema: { params: oneParam, querystring: asOfQuery } },
    async (request, reply) => {
      const regulator = await getRegulator(
        getPool(),
        request.params.id,
        request.params.institutionId,
        request.params.familyCode,
        asOfOf(request.query),
      );
      return reply.send({ regulator });
    },
  );

  app.put(
    '/editions/:id/regulators/:institutionId/:familyCode/contact',
    {
      preHandler: [app.authenticate],
      schema: {
        params: oneParam,
        body: z.object({
          who: z.string(),
          role: z.string(),
          email: z.string(),
          phone: z.string(),
          how: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const regulator = await saveContact(
        getPool(),
        request.params.id,
        request.params.institutionId,
        request.params.familyCode,
        request.body,
      );
      return reply.send({ regulator });
    },
  );

  app.post(
    '/editions/:id/regulators/:institutionId/:familyCode/issue-link',
    {
      preHandler: [app.authenticate],
      schema: { params: oneParam, body: z.object({ targetBy: z.string() }) },
    },
    async (request, reply) => {
      const regulator = await issueSurveyLink(
        getPool(),
        request.params.id,
        request.params.institutionId,
        request.params.familyCode,
        { targetBy: request.body.targetBy },
      );
      return reply.send({ regulator });
    },
  );

  app.post(
    '/editions/:id/regulators/:institutionId/:familyCode/reminder',
    { preHandler: [app.authenticate], schema: { params: oneParam } },
    async (request, reply) => {
      const regulator = await sendReminder(
        getPool(),
        request.params.id,
        request.params.institutionId,
        request.params.familyCode,
      );
      return reply.send({ regulator });
    },
  );

  app.post(
    '/editions/:id/regulators/:institutionId/:familyCode/text-reminder',
    { preHandler: [app.authenticate], schema: { params: oneParam } },
    async (request, reply) => {
      const regulator = await sendTextReminder(
        getPool(),
        request.params.id,
        request.params.institutionId,
        request.params.familyCode,
      );
      return reply.send({ regulator });
    },
  );

  app.post(
    '/editions/:id/regulators/:institutionId/:familyCode/decline',
    { preHandler: [app.authenticate], schema: { params: oneParam } },
    async (request, reply) => {
      const regulator = await markDeclined(
        getPool(),
        request.params.id,
        request.params.institutionId,
        request.params.familyCode,
      );
      return reply.send({ regulator });
    },
  );

  // Phase 19, item 6 — access:regs-gated, no maker-checker (a routine
  // correction of a mistaken decline, not a critical action).
  app.post(
    '/editions/:id/regulators/:institutionId/:familyCode/reopen',
    { preHandler: [app.authenticate], schema: { params: oneParam } },
    async (request, reply) => {
      const pool = getPool();
      const rbac = await loadRbacContext(pool, request.user.sub);
      const regulator = await reopenDeclined(
        pool,
        rbac,
        request.params.id,
        request.params.institutionId,
        request.params.familyCode,
      );
      return reply.send({ regulator });
    },
  );

  app.post(
    '/editions/:id/regulators/:institutionId/:familyCode/submitted',
    { preHandler: [app.authenticate], schema: { params: oneParam } },
    async (request, reply) => {
      const regulator = await markSubmitted(
        getPool(),
        request.params.id,
        request.params.institutionId,
        request.params.familyCode,
      );
      return reply.send({ regulator });
    },
  );

  app.post(
    '/editions/:id/regulators/:institutionId/:familyCode/history',
    {
      preHandler: [app.authenticate],
      schema: { params: oneParam, body: z.object({ entry: z.string() }) },
    },
    async (request, reply) => {
      const regulator = await recordHistory(
        getPool(),
        request.params.id,
        request.params.institutionId,
        request.params.familyCode,
        request.body.entry,
      );
      return reply.send({ regulator });
    },
  );
};
