import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getPool,
  getFirmRespondentStatuses,
  getFirmOutreachSummary,
  listOrganizations,
} from '@cis/db';
import {
  createLeadCoordinator,
  addCoordinator,
  setCoordinatorPin,
  handOverLead,
  removeCoordinator,
  listCoordinators,
} from '@cis/domain';

const CoordinatorSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  role: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  isLead: z.boolean(),
  accessCode: z.string(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
});

/**
 * Firm coordinator (team) administration — UX-FRM-007. Ordinary account admin,
 * NOT maker-checker. Operator-authenticated for now (a firm-coordinator login
 * surface is a later phase); the domain layer enforces the actual rules
 * (lead-handover irreversibility, PIN-requires-current, immediate removal).
 *
 * Also carries the two firm-facing read surfaces that make the visibility
 * boundary demonstrable: respondent completion STATUS only, and outreach
 * COUNTS only — neither can return an individual answer or correlate a response
 * to an outreach link.
 */
export const firmTeamRoutes: FastifyPluginAsyncZod = async (app) => {
  // Firm organisations, for the operator's team-admin picker.
  app.get('/firms', { preHandler: [app.authenticate] }, async (_request, reply) => {
    const orgs = await listOrganizations(getPool());
    return reply.send({
      firms: orgs
        .filter((o) => o.orgType === 'firm')
        .map((o) => ({ id: o.id, displayName: o.displayName, slug: o.slug })),
    });
  });

  app.get(
    '/firms/:orgId/coordinators',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ orgId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const list = await listCoordinators(getPool(), request.params.orgId);
      return reply.send({ coordinators: list });
    },
  );

  // Create the first (lead) coordinator.
  app.post(
    '/firms/:orgId/coordinators/lead',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1),
          email: z.string().min(3),
          role: z.string().nullish(),
          phone: z.string().nullish(),
        }),
        response: { 201: z.object({ coordinator: CoordinatorSchema }) },
      },
    },
    async (request, reply) => {
      const c = await createLeadCoordinator(getPool(), {
        organizationId: request.params.orgId,
        name: request.body.name,
        email: request.body.email,
        role: request.body.role ?? null,
        phone: request.body.phone ?? null,
      });
      return reply.status(201).send({ coordinator: c });
    },
  );

  // Add an additional (non-lead) coordinator.
  app.post(
    '/firms/:orgId/coordinators',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1),
          email: z.string().min(3),
          role: z.string().nullish(),
          phone: z.string().nullish(),
        }),
        response: { 201: z.object({ coordinator: CoordinatorSchema }) },
      },
    },
    async (request, reply) => {
      const c = await addCoordinator(getPool(), {
        organizationId: request.params.orgId,
        name: request.body.name,
        email: request.body.email,
        role: request.body.role ?? null,
        phone: request.body.phone ?? null,
      });
      return reply.status(201).send({ coordinator: c });
    },
  );

  // Change a PIN — requires the current PIN once one is set.
  app.post(
    '/firms/:orgId/coordinators/:coordinatorId/pin',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ orgId: z.string().uuid(), coordinatorId: z.string().uuid() }),
        body: z.object({ newPin: z.string().min(4), currentPin: z.string().optional() }),
      },
    },
    async (request, reply) => {
      await setCoordinatorPin(getPool(), request.params.coordinatorId, {
        newPin: request.body.newPin,
        ...(request.body.currentPin !== undefined ? { currentPin: request.body.currentPin } : {}),
      });
      return reply.send({ ok: true });
    },
  );

  // Hand over the lead role — immediate, only the current lead may do it.
  app.post(
    '/firms/:orgId/coordinators/handover',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        body: z.object({
          actingCoordinatorId: z.string().uuid(),
          newLeadCoordinatorId: z.string().uuid(),
        }),
      },
    },
    async (request, reply) => {
      const { outgoing, incoming } = await handOverLead(getPool(), {
        organizationId: request.params.orgId,
        actingCoordinatorId: request.body.actingCoordinatorId,
        newLeadCoordinatorId: request.body.newLeadCoordinatorId,
      });
      return reply.send({
        outgoing: { id: outgoing.id, isLead: outgoing.isLead },
        incoming: { id: incoming.id, isLead: incoming.isLead },
      });
    },
  );

  // Remove a coordinator — immediate. The lead must hand over first.
  app.delete(
    '/firms/:orgId/coordinators/:coordinatorId',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ orgId: z.string().uuid(), coordinatorId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      await removeCoordinator(getPool(), {
        organizationId: request.params.orgId,
        coordinatorId: request.params.coordinatorId,
      });
      return reply.send({ removed: true });
    },
  );

  // ── Firm-facing read surfaces (visibility boundary) ───────────────────────────

  // Respondent completion STATUS only — never an answer. This is the sole
  // firm-facing view of its respondents.
  app.get(
    '/editions/:editionId/firms/:orgId/respondent-status',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ editionId: z.string().uuid(), orgId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const statuses = await getFirmRespondentStatuses(
        getPool(),
        request.params.editionId,
        request.params.orgId,
      );
      return reply.send({ statuses });
    },
  );

  // Outreach performance — aggregate COUNTS only, structurally non-joinable to
  // any response.
  app.get(
    '/editions/:editionId/firms/:orgId/outreach',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ editionId: z.string().uuid(), orgId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const summary = await getFirmOutreachSummary(
        getPool(),
        request.params.editionId,
        request.params.orgId,
      );
      return reply.send({ outreach: summary });
    },
  );
};
