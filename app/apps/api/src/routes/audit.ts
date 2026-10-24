import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import { getAuditPage, getAuditFacets, exportAuditCsv } from '@cis/domain';

/**
 * D-07 — the audit trail, read-only. Access (setup or Dragnet right) is
 * enforced in the domain layer on every request; there are no write, edit or
 * delete routes here. Exports are themselves audited.
 */
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2})?)?$/, 'Use YYYY-MM-DD');

const FilterQuery = z.object({
  from: DATE.optional(),
  to: DATE.optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().max(200).optional(),
  entityType: z.string().max(200).optional(),
  editionId: z.string().uuid().optional(),
});

const Entry = z.object({
  id: z.string().uuid(),
  occurredAt: z.string(),
  actor: z
    .object({ id: z.string().uuid(), name: z.string().nullable(), email: z.string().nullable() })
    .nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  entityLabel: z.string().nullable(),
  editionId: z.string().nullable(),
  editionLabel: z.string().nullable(),
  oldValue: z.record(z.string(), z.unknown()).nullable(),
  newValue: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});

export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/audit',
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: FilterQuery.extend({ cursor: z.string().uuid().optional() }),
        response: {
          200: z.object({ entries: z.array(Entry), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (request, reply) => {
      const { cursor, ...filter } = request.query;
      const page = await getAuditPage(getPool(), request.user.sub, filter, cursor);
      return reply.send({
        nextCursor: page.nextCursor,
        entries: page.entries.map((e) => ({
          id: e.id,
          occurredAt: e.occurredAt.toISOString(),
          actor: e.actorId ? { id: e.actorId, name: e.actorName, email: e.actorEmail } : null,
          action: e.actionType,
          entityType: e.entityType,
          entityId: e.entityId,
          entityLabel: e.entityLabel,
          editionId: e.editionId,
          editionLabel: e.editionLabel,
          oldValue: e.oldValue,
          newValue: e.newValue,
          reason: e.reason,
          ipAddress: e.ipAddress,
          userAgent: e.userAgent,
        })),
      });
    },
  );

  // The distinct people, actions and item types in the trail, for the filters.
  app.get(
    '/audit/facets',
    {
      preHandler: [app.authenticate],
      schema: {
        response: {
          200: z.object({
            actionTypes: z.array(z.string()),
            entityTypes: z.array(z.string()),
            actors: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
          }),
        },
      },
    },
    async (request, reply) => reply.send(await getAuditFacets(getPool(), request.user.sub)),
  );

  app.get(
    '/audit.csv',
    { preHandler: [app.authenticate], schema: { querystring: FilterQuery } },
    async (request, reply) => {
      const { csv, filename } = await exportAuditCsv(getPool(), request.user.sub, request.query, {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      void reply.header('Content-Type', 'text/csv; charset=utf-8');
      void reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(csv);
    },
  );
};
