import { randomUUID } from 'node:crypto';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool, getOrganizationById, listOrganizations } from '@cis/db';
import {
  claimSpace,
  requestInvitation,
  recordFollowUpConsent,
  getSeats,
  assignSeat,
  describeSeatReplacement,
  confirmSeatReplacement,
  canInviteClients,
  getSeatStatus,
  ensureOutreachLinks,
  getOutreachVolumes,
  updateInvestorCategoriesServed,
} from '@cis/domain';

const INVESTOR_CATEGORY = z.enum([
  'retail',
  'local_institutional',
  'foreign_institutional',
  'not_sure',
]);

/**
 * Firm claim / portal / seats / outreach routes — UX-FRM-001.
 *
 * The claim and request-an-invitation entries are PUBLIC (a firm claiming has no
 * account yet). Seat and outreach management are operator-authenticated for now,
 * matching the Phase 3 firm-team routes (a firm-coordinator login surface is a
 * later phase). The load-bearing rules are enforced in the domain layer; these
 * routes just expose them.
 *
 * Note the deliberate absences, per the struck claims: there is no invitation-
 * count field anywhere, no response-count threshold gating a report, and nothing
 * that gates rating attribution on arrival-via-link.
 */
export const firmPortalRoutes: FastifyPluginAsyncZod = async (app) => {
  // The public firm directory — names and ids only, for claiming and for the
  // request-an-invitation firm picker. A stockbroking firm's name is not
  // confidential; it is the reason the study exists.
  app.get('/firm/directory', async (_request, reply) => {
    const orgs = await listOrganizations(getPool());
    return reply.send({
      firms: orgs
        .filter((o) => o.orgType === 'firm')
        .map((o) => ({ id: o.id, displayName: o.displayName })),
    });
  });

  // Claim a firm's space (privacy consent gates this; one firm, one space).
  app.post(
    '/firm/claim',
    {
      schema: {
        body: z.object({
          organizationId: z.string().uuid(),
          contactName: z.string().min(1),
          contactEmail: z.string().min(3),
          mobile: z.string().min(1),
          pin: z.string().min(6),
          role: z.string().min(1),
          privacyConsent: z.boolean(),
          followUpConsent: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { claim, leadCoordinator } = await claimSpace(getPool(), {
        organizationId: request.body.organizationId,
        contactName: request.body.contactName,
        contactEmail: request.body.contactEmail,
        mobile: request.body.mobile,
        pin: request.body.pin,
        role: request.body.role,
        privacyConsent: request.body.privacyConsent,
        ...(request.body.followUpConsent !== undefined
          ? { followUpConsent: request.body.followUpConsent }
          : {}),
      });
      return reply.status(201).send({
        claim: { id: claim.id, organizationId: claim.organizationId },
        leadCoordinator: { id: leadCoordinator.id, accessCode: leadCoordinator.accessCode },
      });
    },
  );

  // Request an invitation (privacy consent gates; personal domains accepted).
  app.post(
    '/firm/request-invitation',
    {
      schema: {
        body: z.object({
          firmName: z.string().min(1),
          name: z.string().min(1),
          designation: z.string().min(1),
          email: z.string().min(3),
          phone: z.string().min(1),
          privacyConsent: z.boolean(),
        }),
      },
    },
    async (request, reply) => {
      const result = await requestInvitation(getPool(), request.body);
      // domainNote is an operational flag only — never surfaced to the requester
      // as a barrier.
      return reply.status(201).send({ accepted: result.accepted });
    },
  );

  // Per-firm follow-up consent (gates nothing).
  app.patch(
    '/firm/:orgId/follow-up-consent',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        body: z.object({ followUpConsent: z.boolean() }),
      },
    },
    async (request, reply) => {
      await recordFollowUpConsent(getPool(), request.params.orgId, request.body.followUpConsent);
      return reply.send({ ok: true });
    },
  );

  // UX-FRM-002 — investor categories served. Editable at any time by the
  // firm's coordinator, same as every other firm-portal self-service field:
  // no critical action, no maker-checker. Zero effect on scoring, eligibility
  // or evidence packs — see @cis/domain's investor-categories-service.
  app.get(
    '/firm/:orgId/investor-categories',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ orgId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const org = await getOrganizationById(getPool(), request.params.orgId);
      if (!org) return reply.status(404).send({ error: 'Not Found', message: 'Firm not found' });
      return reply.send({ investorCategoriesServed: org.investorCategoriesServed });
    },
  );

  app.put(
    '/firm/:orgId/investor-categories',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        body: z.object({ categories: z.array(INVESTOR_CATEGORY) }),
      },
    },
    async (request, reply) => {
      const org = await updateInvestorCategoriesServed(
        getPool(),
        request.params.orgId,
        request.body.categories,
      );
      return reply.send({ investorCategoriesServed: org.investorCategoriesServed });
    },
  );

  // The three seats for a firm in an edition.
  app.get(
    '/firm/:orgId/editions/:editionId/seats',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ orgId: z.string().uuid(), editionId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const seats = await getSeats(getPool(), request.params.editionId, request.params.orgId);
      return reply.send({ seats });
    },
  );

  app.post(
    '/firm/:orgId/editions/:editionId/seats/:seatCode/assign',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({
          orgId: z.string().uuid(),
          editionId: z.string().uuid(),
          seatCode: z.enum(['S1', 'S2', 'S3']),
        }),
        body: z.object({
          assignedName: z.string().min(1),
          assignedEmail: z.string().min(3),
          isSelf: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const seat = await assignSeat(getPool(), {
        editionId: request.params.editionId,
        organizationId: request.params.orgId,
        seatCode: request.params.seatCode,
        assignedName: request.body.assignedName,
        assignedEmail: request.body.assignedEmail,
        ...(request.body.isSelf !== undefined ? { isSelf: request.body.isSelf } : {}),
      });
      return reply.send({ seat });
    },
  );

  // Describe the cost of replacing a seat's occupant (before confirming).
  app.get(
    '/firm/:orgId/editions/:editionId/seats/:seatCode/replacement',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({
          orgId: z.string().uuid(),
          editionId: z.string().uuid(),
          seatCode: z.enum(['S1', 'S2', 'S3']),
        }),
      },
    },
    async (request, reply) => {
      const cost = await describeSeatReplacement(
        getPool(),
        request.params.editionId,
        request.params.orgId,
        request.params.seatCode,
      );
      return reply.send(cost);
    },
  );

  // Perform the replacement (clears the seat back to empty).
  app.post(
    '/firm/:orgId/editions/:editionId/seats/:seatCode/replace',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({
          orgId: z.string().uuid(),
          editionId: z.string().uuid(),
          seatCode: z.enum(['S1', 'S2', 'S3']),
        }),
      },
    },
    async (request, reply) => {
      const seat = await confirmSeatReplacement(
        getPool(),
        request.params.editionId,
        request.params.orgId,
        request.params.seatCode,
      );
      return reply.send({ seat });
    },
  );

  // Sequence lock: whether inviting clients is unlocked, and why not if locked.
  app.get(
    '/firm/:orgId/editions/:editionId/can-invite',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ orgId: z.string().uuid(), editionId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const state = await canInviteClients(
        getPool(),
        request.params.editionId,
        request.params.orgId,
      );
      return reply.send(state);
    },
  );

  // Firm-facing seat STATUS only (never answer content).
  app.get(
    '/firm/:orgId/editions/:editionId/seat-status',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ orgId: z.string().uuid(), editionId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const statuses = await getSeatStatus(
        getPool(),
        request.params.editionId,
        request.params.orgId,
      );
      return reply.send({ statuses });
    },
  );

  // Outreach: ensure the three segment links exist, then per-segment volumes.
  app.get(
    '/firm/:orgId/editions/:editionId/outreach',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ orgId: z.string().uuid(), editionId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const pool = getPool();
      await ensureOutreachLinks(pool, request.params.editionId, request.params.orgId, () =>
        randomUUID(),
      );
      const volumes = await getOutreachVolumes(
        pool,
        request.params.editionId,
        request.params.orgId,
      );
      return reply.send({ volumes });
    },
  );
};
