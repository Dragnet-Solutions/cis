import type { FastifyReply } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool, getActiveEditionParticipants, getConfig, listEditions } from '@cis/db';
import {
  startJourney,
  registerContact,
  setRatedFirms,
  saveDraftAnswer,
  getResume,
  submitJourney,
  createReferral,
  createColleagueInvite,
  stopReminders,
} from '@cis/domain';
import { getRespondentByRecoveryToken, setReportDelivery } from '@cis/db';
import type { AnswerValue } from '@cis/survey';

const not = (reply: FastifyReply, code: number, error: string, message: string) =>
  reply.status(code).send({ error, message, statusCode: code });

const AnswerSchema = z.object({ a: z.unknown(), c: z.string().optional() });

/**
 * Respondent-facing journey surfaces. These are PUBLIC (no operator auth): a
 * respondent has no admin account and never sees the portal. The respondent id
 * (an unguessable UUID) and the recovery token are the only handles into a
 * journey. The firm-facing visibility boundary is enforced elsewhere (firm
 * accessors return status/counts only) — nothing here exposes another
 * respondent's answers.
 */
export const journeyRoutes: FastifyPluginAsyncZod = async (app) => {
  // Public journey context: the edition a respondent is answering (the open
  // one, else the most recent) and the governed public-results content flag
  // (UX-PUB-001). No respondent data — safe to serve unauthenticated.
  app.get('/journeys/context', async (_request, reply) => {
    const pool = getPool();
    const editions = await listEditions(pool);
    const current = editions.find((e) => e.status === 'open') ?? editions[0] ?? null;
    const resultsVisible = await getConfig<boolean>(pool, 'public.results_section_visible');
    return reply.send({
      editionId: current?.id ?? null,
      editionLabel: current?.label ?? null,
      resultsSectionVisible: resultsVisible ?? false,
    });
  });

  // Governed consent copy + parameters for the entry surface. PAT-011 wording is
  // never hardcoded in the client — it is fetched from here.
  app.get('/journeys/consent-content', async (_request, reply) => {
    const pool = getPool();
    const [consent, ttl] = await Promise.all([
      getConfig(pool, 'consent.pat011'),
      getConfig<number>(pool, 'recovery.link_ttl_seconds'),
    ]);
    return reply.send({ consent, recoveryTtlSeconds: ttl });
  });

  // The firms a multi-firm respondent may pick — real edition-scoped active
  // participants only.
  app.get(
    '/journeys/editions/:editionId/participating-firms',
    { schema: { params: z.object({ editionId: z.string().uuid() }) } },
    async (request, reply) => {
      const firms = await getActiveEditionParticipants(getPool(), request.params.editionId);
      return reply.send({
        firms: firms.map((f) => ({ id: f.id, displayName: f.displayName, slug: f.slug })),
      });
    },
  );

  // Start a journey.
  app.post(
    '/journeys',
    {
      schema: {
        body: z.object({
          editionId: z.string().uuid(),
          instrumentCode: z.string().min(1),
          recruitingFirmId: z.string().uuid().nullish(),
          institutionName: z.string().nullish(),
        }),
      },
    },
    async (request, reply) => {
      const r = await startJourney(getPool(), {
        editionId: request.body.editionId,
        instrumentCode: request.body.instrumentCode,
        recruitingFirmId: request.body.recruitingFirmId ?? null,
        institutionName: request.body.institutionName ?? null,
      });
      return reply.status(201).send({ respondentId: r.id });
    },
  );

  // Record consent + contact (PAT-011). Consent is enforced server-side.
  app.post(
    '/journeys/:respondentId/contact',
    {
      schema: {
        params: z.object({ respondentId: z.string().uuid() }),
        body: z.object({
          consentAccepted: z.boolean(),
          channel: z.enum(['email', 'text', 'both', 'none']),
          email: z.string().nullish(),
          phone: z.string().nullish(),
        }),
      },
    },
    async (request, reply) => {
      const r = await registerContact(getPool(), request.params.respondentId, {
        consentAccepted: request.body.consentAccepted,
        channel: request.body.channel,
        email: request.body.email ?? null,
        phone: request.body.phone ?? null,
      });
      return reply.send({ respondentId: r.id, recoveryToken: r.recoveryToken });
    },
  );

  // Choose the firms to rate (multi-firm). Recruiting firm is never auto-added.
  app.post(
    '/journeys/:respondentId/rated-firms',
    {
      schema: {
        params: z.object({ respondentId: z.string().uuid() }),
        body: z.object({ firmIds: z.array(z.string().uuid()) }),
      },
    },
    async (request, reply) => {
      const r = await setRatedFirms(getPool(), request.params.respondentId, request.body.firmIds);
      return reply.send({ ratedFirmIds: r.ratedFirmIds });
    },
  );

  // Autosave one answer (no save control — every change persists a draft).
  app.put(
    '/journeys/:respondentId/answers',
    {
      schema: {
        params: z.object({ respondentId: z.string().uuid() }),
        body: z.object({
          questionId: z.string().min(1),
          ratedFirmId: z.string().uuid().nullable(),
          answer: AnswerSchema,
          step: z.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const draft = await saveDraftAnswer(getPool(), request.params.respondentId, {
        questionId: request.body.questionId,
        ratedFirmId: request.body.ratedFirmId,
        answer: request.body.answer as AnswerValue,
        ...(request.body.step !== undefined ? { step: request.body.step } : {}),
      });
      return reply.send({ draft });
    },
  );

  // Resume by respondent id — restores exact firm context mid-loop.
  app.get(
    '/journeys/:respondentId/resume',
    { schema: { params: z.object({ respondentId: z.string().uuid() }) } },
    async (request, reply) => {
      const state = await getResume(getPool(), request.params.respondentId);
      return reply.send(state);
    },
  );

  // Resume by recovery token (emailed / device-bound link).
  // Returns a typed state: 'resume' (in-progress), 'already_submitted',
  // 'participation_closed' (UX-X-001 — a genuine withdrawal, never Phase 17's
  // reminders_opted_out), or 404 (the shared 'no_unfinished_survey' state —
  // this response never carries a respondent id, name, or answer fragment).
  app.get(
    '/journeys/resume/:token',
    { schema: { params: z.object({ token: z.string().min(1) }) } },
    async (request, reply) => {
      const pool = getPool();
      const respondent = await getRespondentByRecoveryToken(pool, request.params.token);
      if (!respondent) return not(reply, 404, 'Not Found', 'No journey for this recovery link');
      if (respondent.withdrawnAt) {
        return reply.send({ kind: 'participation_closed' });
      }
      if (respondent.submittedAt) {
        return reply.send({ kind: 'already_submitted' });
      }
      const state = await getResume(pool, respondent.id);
      return reply.send({ kind: 'resume', ...state });
    },
  );

  // Stop reminders — sets reminders_opted_out without altering participation status.
  // Identified by recovery token so the tap from an SMS link works without a session.
  app.post(
    '/journeys/stop-reminders/:token',
    { schema: { params: z.object({ token: z.string().min(1) }) } },
    async (request, reply) => {
      const pool = getPool();
      const respondent = await getRespondentByRecoveryToken(pool, request.params.token);
      if (!respondent) return not(reply, 404, 'Not Found', 'No journey for this recovery link');
      await stopReminders(pool, respondent.id);
      return reply.send({ kind: 'reminders_stopped' });
    },
  );

  // Submit — freeze drafts into immutable responses (review-before-submit gate).
  app.post(
    '/journeys/:respondentId/submit',
    { schema: { params: z.object({ respondentId: z.string().uuid() }) } },
    async (request, reply) => {
      const written = await submitJourney(getPool(), request.params.respondentId);
      return reply.send({ submitted: true, responseCount: written.length });
    },
  );

  // Change report-delivery preference (UX-RET-008) — answers untouched.
  app.patch(
    '/journeys/:respondentId/report-delivery',
    {
      schema: {
        params: z.object({ respondentId: z.string().uuid() }),
        body: z.object({
          reportDelivery: z.string().min(1),
          email: z.string().nullish(),
          phone: z.string().nullish(),
        }),
      },
    },
    async (request, reply) => {
      const r = await setReportDelivery(getPool(), request.params.respondentId, {
        reportDelivery: request.body.reportDelivery,
        email: request.body.email ?? null,
        phone: request.body.phone ?? null,
      });
      return reply.send({ reportDelivery: r.reportDelivery });
    },
  );

  // Post-completion retail referral — a fresh independent journey that never
  // inherits the referrer's source firm.
  app.post(
    '/journeys/:respondentId/referral',
    {
      schema: {
        params: z.object({ respondentId: z.string().uuid() }),
        body: z.object({ editionId: z.string().uuid(), instrumentCode: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const r = await createReferral(getPool(), {
        editionId: request.body.editionId,
        instrumentCode: request.body.instrumentCode,
        referredByRespondentId: request.params.respondentId,
      });
      return reply.status(201).send({ respondentId: r.id });
    },
  );

  // Institutional colleague invite — independent, carries institution name only,
  // no link back to the inviter.
  app.post(
    '/journeys/colleague-invite',
    {
      schema: {
        body: z.object({
          editionId: z.string().uuid(),
          instrumentCode: z.string().min(1),
          institutionName: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const r = await createColleagueInvite(getPool(), {
        editionId: request.body.editionId,
        instrumentCode: request.body.instrumentCode,
        institutionName: request.body.institutionName,
      });
      return reply.status(201).send({ respondentId: r.id });
    },
  );
};
