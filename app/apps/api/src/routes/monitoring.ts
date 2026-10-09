import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import {
  getResponsesMonitor,
  getUnfinishedStats,
  getDropoffHistogram,
  getReminderSchedule,
  setReminderSchedule,
  getReminderCap,
  setReminderCap,
  scheduleDueReminders,
  withdrawRespondent,
} from '@cis/domain';

/**
 * Monitoring routes — UX-OPS-003 (Responses) and UX-OPS-004 (Reminder timing).
 * Reads reuse the mission board's own computation; the reminder schedule/cap are
 * governed config; scheduling records sends and never touches response state.
 */
export const monitoringRoutes: FastifyPluginAsyncZod = async (app) => {
  const editionParam = z.object({ id: z.string().uuid() });
  const asOfQuery = z.object({ asOf: z.string().datetime().optional() });
  const asOfOf = (q: { asOf?: string }): Date => (q.asOf ? new Date(q.asOf) : new Date());

  // ── UX-OPS-003 ────────────────────────────────────────────────────────────
  app.get(
    '/editions/:id/responses-monitor',
    { preHandler: [app.authenticate], schema: { params: editionParam, querystring: asOfQuery } },
    async (request, reply) => {
      const monitor = await getResponsesMonitor(
        getPool(),
        request.params.id,
        asOfOf(request.query),
      );
      return reply.send(monitor);
    },
  );

  // ── UX-OPS-004 ────────────────────────────────────────────────────────────
  app.get(
    '/editions/:id/unfinished',
    { preHandler: [app.authenticate], schema: { params: editionParam } },
    async (request, reply) => {
      const [stats, dropoff, schedule, cap] = await Promise.all([
        getUnfinishedStats(getPool(), request.params.id),
        getDropoffHistogram(getPool(), request.params.id),
        getReminderSchedule(getPool()),
        getReminderCap(getPool()),
      ]);
      return reply.send({ stats, dropoff, schedule, cap });
    },
  );

  app.put(
    '/reminders/schedule',
    {
      preHandler: [app.authenticate],
      schema: {
        body: z.object({
          steps: z.array(
            z.object({
              step: z.number().int().positive(),
              kind: z.enum(['relative', 'before_close']),
              days: z.number().int().positive().optional(),
              beforeCloseDays: z.number().int().positive().optional(),
              enabled: z.boolean(),
            }),
          ),
        }),
      },
    },
    async (request, reply) => {
      await setReminderSchedule(getPool(), request.body);
      return reply.send({ schedule: await getReminderSchedule(getPool()) });
    },
  );

  app.put(
    '/reminders/cap',
    {
      preHandler: [app.authenticate],
      schema: { body: z.object({ cap: z.number().int().nonnegative() }) },
    },
    async (request, reply) => {
      await setReminderCap(getPool(), request.body.cap);
      return reply.send({ cap: await getReminderCap(getPool()) });
    },
  );

  app.post(
    '/editions/:id/reminders/run',
    { preHandler: [app.authenticate], schema: { params: editionParam, querystring: asOfQuery } },
    async (request, reply) => {
      const sent = await scheduleDueReminders(getPool(), request.params.id, asOfOf(request.query));
      return reply.send({ sent });
    },
  );

  // UX-X-001 — a genuine withdrawal, operator-triggered only. The flag and the
  // check are the entire mechanism here: no self-service withdrawal request
  // flow is built (see README §Phase 18 for the deliberate scope boundary).
  app.post(
    '/respondents/:id/withdraw',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      await withdrawRespondent(getPool(), request.params.id);
      return reply.send({ withdrawn: true });
    },
  );
};
