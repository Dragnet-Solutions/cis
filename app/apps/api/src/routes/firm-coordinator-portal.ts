import { randomUUID } from 'node:crypto';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool, getOrganizationById, listEditions } from '@cis/db';
import {
  listCoordinators,
  addCoordinator,
  handOverLead,
  removeCoordinator,
  recordFollowUpConsent,
  updateInvestorCategoriesServed,
  getSeats,
  assignSeat,
  describeSeatReplacement,
  confirmSeatReplacement,
  canInviteClients,
  getSeatStatus,
  ensureOutreachLinks,
  listOutreachLinksForFirm,
} from '@cis/domain';

const INVESTOR_CATEGORY = z.enum([
  'retail',
  'local_institutional',
  'foreign_institutional',
  'not_sure',
]);

/**
 * The firm portal's own routes — UX-FRM-001/002/007 — wrapping the same
 * domain services the operator-authenticated firm-team / firm-portal routes
 * already use, behind `authenticateCoordinator` instead. Every route is
 * self-scoped to the signed-in coordinator's own `organizationId`: it is
 * read from the session token, never from a client-supplied parameter, so a
 * coordinator can never act on, or even name, a firm other than their own.
 *
 * "Current edition" resolves the same way the public journey-context and
 * previous-editions routes already do: the open one, else the most recent —
 * a coordinator's portal has no edition picker of its own.
 */
export const firmCoordinatorPortalRoutes: FastifyPluginAsyncZod = async (app) => {
  async function currentEdition(): Promise<{
    id: string;
    status: 'draft' | 'open' | 'locked' | 'archived';
  } | null> {
    const editions = await listEditions(getPool());
    const current = editions.find((e) => e.status === 'open') ?? editions[0] ?? null;
    return current ? { id: current.id, status: current.status } : null;
  }

  async function currentEditionId(): Promise<string | null> {
    return (await currentEdition())?.id ?? null;
  }

  // The signed-in coordinator's own profile, firm, and the edition the rest
  // of the portal operates against.
  app.get('/portal/me', { preHandler: [app.authenticateCoordinator] }, async (request, reply) => {
    const pool = getPool();
    const session = request.coordinatorSession;
    const [org, edition] = await Promise.all([
      getOrganizationById(pool, session.organizationId),
      currentEdition(),
    ]);
    const coordinators = await listCoordinators(pool, session.organizationId);
    const self = coordinators.find((c) => c.id === session.sub) ?? null;
    return reply.send({
      coordinator: self
        ? {
            id: self.id,
            name: self.name,
            email: self.email,
            role: self.role,
            phone: self.phone,
            isLead: self.isLead,
            accessCode: self.accessCode,
          }
        : null,
      organization: org ? { id: org.id, displayName: org.displayName, slug: org.slug } : null,
      currentEdition: edition,
    });
  });

  // ── Team ───────────────────────────────────────────────────────────────────

  app.get('/portal/team', { preHandler: [app.authenticateCoordinator] }, async (request, reply) => {
    const list = await listCoordinators(getPool(), request.coordinatorSession.organizationId);
    return reply.send({ coordinators: list });
  });

  app.post(
    '/portal/team',
    {
      preHandler: [app.authenticateCoordinator],
      schema: {
        body: z.object({
          name: z.string().min(1),
          email: z.string().min(3),
          role: z.string().nullish(),
          phone: z.string().nullish(),
        }),
      },
    },
    async (request, reply) => {
      const c = await addCoordinator(getPool(), {
        organizationId: request.coordinatorSession.organizationId,
        name: request.body.name,
        email: request.body.email,
        role: request.body.role ?? null,
        phone: request.body.phone ?? null,
      });
      return reply.status(201).send({ coordinator: c });
    },
  );

  // Hand over the lead role. The acting coordinator is always the signed-in
  // session — never a client-supplied id — so only the true lead can do this.
  app.post(
    '/portal/team/:coordinatorId/handover',
    {
      preHandler: [app.authenticateCoordinator],
      schema: { params: z.object({ coordinatorId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const { outgoing, incoming } = await handOverLead(getPool(), {
        organizationId: request.coordinatorSession.organizationId,
        actingCoordinatorId: request.coordinatorSession.sub,
        newLeadCoordinatorId: request.params.coordinatorId,
      });
      return reply.send({
        outgoing: { id: outgoing.id, isLead: outgoing.isLead },
        incoming: { id: incoming.id, isLead: incoming.isLead },
      });
    },
  );

  app.delete(
    '/portal/team/:coordinatorId',
    {
      preHandler: [app.authenticateCoordinator],
      schema: { params: z.object({ coordinatorId: z.string().uuid() }) },
    },
    async (request, reply) => {
      await removeCoordinator(getPool(), {
        organizationId: request.coordinatorSession.organizationId,
        coordinatorId: request.params.coordinatorId,
      });
      return reply.send({ removed: true });
    },
  );

  // ── Firm profile ───────────────────────────────────────────────────────────

  app.patch(
    '/portal/follow-up-consent',
    {
      preHandler: [app.authenticateCoordinator],
      schema: { body: z.object({ followUpConsent: z.boolean() }) },
    },
    async (request, reply) => {
      await recordFollowUpConsent(
        getPool(),
        request.coordinatorSession.organizationId,
        request.body.followUpConsent,
      );
      return reply.send({ ok: true });
    },
  );

  app.get(
    '/portal/investor-categories',
    { preHandler: [app.authenticateCoordinator] },
    async (request, reply) => {
      const org = await getOrganizationById(getPool(), request.coordinatorSession.organizationId);
      if (!org) return reply.status(404).send({ error: 'Not Found', message: 'Firm not found' });
      return reply.send({ investorCategoriesServed: org.investorCategoriesServed });
    },
  );

  app.put(
    '/portal/investor-categories',
    {
      preHandler: [app.authenticateCoordinator],
      schema: { body: z.object({ categories: z.array(INVESTOR_CATEGORY) }) },
    },
    async (request, reply) => {
      const org = await updateInvestorCategoriesServed(
        getPool(),
        request.coordinatorSession.organizationId,
        request.body.categories,
      );
      return reply.send({ investorCategoriesServed: org.investorCategoriesServed });
    },
  );

  // ── Seats ──────────────────────────────────────────────────────────────────

  app.get(
    '/portal/seats',
    { preHandler: [app.authenticateCoordinator] },
    async (request, reply) => {
      const editionId = await currentEditionId();
      if (!editionId) return reply.send({ seats: [] });
      const seats = await getSeats(getPool(), editionId, request.coordinatorSession.organizationId);
      return reply.send({ seats });
    },
  );

  app.post(
    '/portal/seats/:seatCode/assign',
    {
      preHandler: [app.authenticateCoordinator],
      schema: {
        params: z.object({ seatCode: z.enum(['S1', 'S2', 'S3']) }),
        body: z.object({
          assignedName: z.string().min(1),
          assignedEmail: z.string().min(3),
          isSelf: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const editionId = await currentEditionId();
      if (!editionId) {
        return reply
          .status(409)
          .send({ error: 'Conflict', message: 'No edition is open', statusCode: 409 });
      }
      const seat = await assignSeat(getPool(), {
        editionId,
        organizationId: request.coordinatorSession.organizationId,
        seatCode: request.params.seatCode,
        assignedName: request.body.assignedName,
        assignedEmail: request.body.assignedEmail,
        ...(request.body.isSelf !== undefined ? { isSelf: request.body.isSelf } : {}),
      });
      return reply.send({ seat });
    },
  );

  app.get(
    '/portal/seats/:seatCode/replacement',
    {
      preHandler: [app.authenticateCoordinator],
      schema: { params: z.object({ seatCode: z.enum(['S1', 'S2', 'S3']) }) },
    },
    async (request, reply) => {
      const editionId = await currentEditionId();
      if (!editionId) {
        return reply
          .status(409)
          .send({ error: 'Conflict', message: 'No edition is open', statusCode: 409 });
      }
      const cost = await describeSeatReplacement(
        getPool(),
        editionId,
        request.coordinatorSession.organizationId,
        request.params.seatCode,
      );
      return reply.send(cost);
    },
  );

  app.post(
    '/portal/seats/:seatCode/replace',
    {
      preHandler: [app.authenticateCoordinator],
      schema: { params: z.object({ seatCode: z.enum(['S1', 'S2', 'S3']) }) },
    },
    async (request, reply) => {
      const editionId = await currentEditionId();
      if (!editionId) {
        return reply
          .status(409)
          .send({ error: 'Conflict', message: 'No edition is open', statusCode: 409 });
      }
      const seat = await confirmSeatReplacement(
        getPool(),
        editionId,
        request.coordinatorSession.organizationId,
        request.params.seatCode,
      );
      return reply.send({ seat });
    },
  );

  app.get(
    '/portal/can-invite',
    { preHandler: [app.authenticateCoordinator] },
    async (request, reply) => {
      const editionId = await currentEditionId();
      if (!editionId) {
        return reply.send({ allowed: false, reason: 'No edition is open.', assignedCount: 0 });
      }
      const state = await canInviteClients(
        getPool(),
        editionId,
        request.coordinatorSession.organizationId,
      );
      return reply.send(state);
    },
  );

  app.get(
    '/portal/seat-status',
    { preHandler: [app.authenticateCoordinator] },
    async (request, reply) => {
      const editionId = await currentEditionId();
      if (!editionId) return reply.send({ statuses: [] });
      const statuses = await getSeatStatus(
        getPool(),
        editionId,
        request.coordinatorSession.organizationId,
      );
      return reply.send({ statuses });
    },
  );

  // ── Outreach ───────────────────────────────────────────────────────────────

  app.get(
    '/portal/outreach',
    { preHandler: [app.authenticateCoordinator] },
    async (request, reply) => {
      const editionId = await currentEditionId();
      if (!editionId) return reply.send({ volumes: [] });
      const pool = getPool();
      const organizationId = request.coordinatorSession.organizationId;
      await ensureOutreachLinks(pool, editionId, organizationId, () => randomUUID());
      const links = await listOutreachLinksForFirm(pool, editionId, organizationId);
      return reply.send({
        links: links.map((l) => ({
          token: l.token,
          segment: l.segment,
          opens: l.opens,
          starts: l.starts,
          finishes: l.finishes,
        })),
      });
    },
  );
};
