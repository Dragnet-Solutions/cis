import type { FastifyReply } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getPool,
  getNationalReport,
  getLatestNationalReportForEdition,
  getDisplayNamesByIdentifier,
  getReportPublication,
  listEmailsFor,
} from '@cis/db';
import {
  generateNationalReport,
  openDraft,
  nationalApprovalPreconditions,
  requestNationalApproval,
  approveNational,
  getSections,
  generateFirmReports,
  approveFirmReport,
  regenerateFirmReport,
  releaseFirmReports,
  getFirmReports,
  currentSegmentSufficiency,
  buildIndustryReportContent,
  buildFirmReportContent,
  generateIndustryNarrative,
  generateFirmNarrative,
  getIndustryNarrative,
  getFirmNarrative,
  ensureIndustryNarrative,
  ensureFirmNarrative,
  publishIndustryReport,
  queueReleaseNotices,
  NATIONAL_SECTIONS,
  type SufficiencyContext,
} from '@cis/domain';
import type { ReportNarrative } from '@cis/db';
import { foundryModelFromEnv } from '../ai/foundry-model';
import { deliverQueuedEmails } from '../mail/mailer';
import { renderReportPdf, type PdfSession } from '../pdf/report-pdf';

/**
 * Reporting routes — UX-ADM-005 (national report review/approval) and
 * UX-ADM-006 (firm report generation/release). Operator-authenticated. The two
 * surfaces are kept distinct: their guarantee semantics differ, and conflating
 * them is the historical mistake this design corrects.
 */
export const reportingRoutes: FastifyPluginAsyncZod = async (app) => {
  const segment = z.object({ meets: z.boolean(), thin: z.boolean() });

  // ── National report (UX-ADM-005) ──────────────────────────────────────────
  app.post(
    '/editions/:id/national-report',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          scoringRunId: z.string().uuid(),
          context: z.object({
            segments: z.record(z.string(), segment),
            regulatorsEngaged: z.number().int().min(0).max(3),
          }),
        }),
      },
    },
    async (request, reply) => {
      const { report, sections } = await generateNationalReport(getPool(), {
        editionId: request.params.id,
        scoringRunId: request.body.scoringRunId,
        context: request.body.context as SufficiencyContext,
      });
      return reply.status(201).send({ reportId: report.id, sections });
    },
  );

  // Live per-segment sufficiency (counted vs floor), so the national-report
  // inputs start from the data rather than from a default of "meets".
  app.get(
    '/editions/:id/sufficiency',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const sufficiency = await currentSegmentSufficiency(getPool(), request.params.id);
      return reply.send({ sufficiency });
    },
  );

  // The CONTENT of the two report documents — the public Industry report and
  // a firm's private report — computed from submitted responses
  // (report-content-service.ts), with the AI-drafted narrative in force, if any
  // (report-narrative-service.ts). Operator-only: the firm report is private to
  // its firm, so only study operations can open it here.
  // Where a released firm's coordinators sign in to read their report.
  const portalUrl = () =>
    `${new URL(process.env['PORTAL_URL'] || process.env['REPORT_RENDER_URL'] || 'http://localhost:5174').origin}/firm`;

  const narrativeView = (n: ReportNarrative | null) =>
    n && {
      model: n.model,
      createdAt: n.createdAt,
      createdBy: n.createdBy,
      sentences: n.sentences,
    };

  app.get(
    '/editions/:id/reports/industry',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const pool = getPool();
      const content = await buildIndustryReportContent(pool, request.params.id);
      const narrative = await getIndustryNarrative(pool, request.params.id);
      const published = await getReportPublication(pool, request.params.id, 'industry', null);
      return reply.send({
        ...content,
        narrative: narrativeView(narrative),
        publishedAt: published?.publishedAt ?? null,
      });
    },
  );

  app.get(
    '/editions/:id/firms/:firmId/report',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid(), firmId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const pool = getPool();
      const { id, firmId } = request.params;
      const content = await buildFirmReportContent(pool, id, firmId);
      const narrative = await getFirmNarrative(pool, id, firmId);
      const published = await getReportPublication(pool, id, 'firm', firmId);
      return reply.send({
        ...content,
        narrative: narrativeView(narrative),
        publishedAt: published?.publishedAt ?? null,
      });
    },
  );

  // Draft (or redraft) the narrative with the Foundry model. Who asked is the
  // signed-in operator, recorded with the generation.
  app.post(
    '/editions/:id/reports/industry/narrative',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const narrative = await generateIndustryNarrative(
        getPool(),
        request.params.id,
        foundryModelFromEnv(),
        request.session.email,
      );
      return reply.status(201).send({ narrative: narrativeView(narrative) });
    },
  );

  app.post(
    '/editions/:id/firms/:firmId/report/narrative',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid(), firmId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const narrative = await generateFirmNarrative(
        getPool(),
        request.params.id,
        request.params.firmId,
        foundryModelFromEnv(),
        request.session.email,
      );
      return reply.status(201).send({ narrative: narrativeView(narrative) });
    },
  );

  // The narrative drafts itself: opening a report (or asking for its PDF)
  // drafts it when the figures exist and the narrative in force is missing or
  // was written from figures that have since changed. Otherwise the narrative
  // in force is returned untouched — no model call.
  app.post(
    '/editions/:id/reports/industry/narrative/ensure',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const narrative = await ensureIndustryNarrative(
        getPool(),
        request.params.id,
        foundryModelFromEnv,
        request.session.email,
      );
      return reply.send({ narrative: narrativeView(narrative) });
    },
  );

  app.post(
    '/editions/:id/firms/:firmId/report/narrative/ensure',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid(), firmId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const narrative = await ensureFirmNarrative(
        getPool(),
        request.params.id,
        request.params.firmId,
        foundryModelFromEnv,
        request.session.email,
      );
      return reply.send({ narrative: narrativeView(narrative) });
    },
  );

  // Publish the Industry report to the public — happens by itself when the
  // national report is approved; this is the retry if the analysis could not be
  // drafted then. Idempotent.
  app.post(
    '/editions/:id/reports/industry/publish',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const publication = await publishIndustryReport(
        getPool(),
        request.params.id,
        foundryModelFromEnv,
        request.session.email,
      );
      return reply.send({ publishedAt: publication.publishedAt });
    },
  );

  // The report as a PDF — the real report page printed by headless Chrome
  // (pdf/report-pdf.ts). The narrative is drafted first if it is due: the PDF
  // is the finished document, so it is never produced from figures alone.
  const pdfSession = (request: {
    headers: { authorization?: string };
    session: { sub: string; email: string; displayName: string; org: string | null };
  }): PdfSession => ({
    storageKey: 'cis.admin.session',
    value: {
      token: (request.headers.authorization ?? '').replace(/^Bearer\s+/i, ''),
      user: {
        id: request.session.sub,
        email: request.session.email,
        displayName: request.session.displayName,
        org: request.session.org,
        hasDragnetRight: false,
      },
    },
  });
  const noNarrative = {
    error: 'Conflict',
    message: 'There are no figures to write about yet, so there is no report to download.',
    statusCode: 409,
  };
  const sendPdf = (reply: FastifyReply, pdf: Buffer, filename: string) =>
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(pdf);

  app.get(
    '/editions/:id/reports/industry/pdf',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const pool = getPool();
      const ready = await ensureIndustryNarrative(
        pool,
        request.params.id,
        foundryModelFromEnv,
        request.session.email,
      );
      if (!ready) {
        return reply.status(409).send(noNarrative);
      }
      const content = await buildIndustryReportContent(pool, request.params.id);
      const pdf = await renderReportPdf(
        `/print/industry?edition=${request.params.id}`,
        pdfSession(request),
      );
      return sendPdf(reply, pdf, `CIS-Dragnet-Industry-Report-${content.edition.label}.pdf`);
    },
  );

  // Institutional Perspectives — the Industry report's section 10 as its own
  // document, from the same content and narrative.
  app.get(
    '/editions/:id/reports/institutional/pdf',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const pool = getPool();
      const ready = await ensureIndustryNarrative(
        pool,
        request.params.id,
        foundryModelFromEnv,
        request.session.email,
      );
      if (!ready) {
        return reply.status(409).send(noNarrative);
      }
      const content = await buildIndustryReportContent(pool, request.params.id);
      const pdf = await renderReportPdf(
        `/print/institutional?edition=${request.params.id}`,
        pdfSession(request),
      );
      return sendPdf(
        reply,
        pdf,
        `CIS-Dragnet-Institutional-Perspectives-${content.edition.label}.pdf`,
      );
    },
  );

  app.get(
    '/editions/:id/firms/:firmId/report/pdf',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid(), firmId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const pool = getPool();
      const { id, firmId } = request.params;
      if (
        !(await ensureFirmNarrative(pool, id, firmId, foundryModelFromEnv, request.session.email))
      ) {
        return reply.status(409).send(noNarrative);
      }
      const content = await buildFirmReportContent(pool, id, firmId);
      const pdf = await renderReportPdf(
        `/print/firm?edition=${id}&firm=${firmId}`,
        pdfSession(request),
      );
      const slug = content.firm.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return sendPdf(reply, pdf, `CIS-Dragnet-Firm-Report-${slug}-${content.edition.label}.pdf`);
    },
  );

  // The current (most recently created) report for an edition, if any — lets a
  // fresh page load discover the report without the frontend remembering an id.
  app.get(
    '/editions/:id/national-report',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const pool = getPool();
      const report = await getLatestNationalReportForEdition(pool, request.params.id);
      const operatorNames = report
        ? await getDisplayNamesByIdentifier(pool, [
            report.requestedBy ?? '',
            report.approvedBy ?? '',
          ])
        : {};
      return reply.send({ report, operatorNames });
    },
  );

  app.get(
    '/national-reports/:id',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const pool = getPool();
      const report = await getNationalReport(pool, request.params.id);
      if (!report)
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'No such report', statusCode: 404 });
      // Each section carries its human name alongside the contract id.
      const nameOf = new Map(NATIONAL_SECTIONS.map((s) => [s.id, s.name]));
      const sections = (await getSections(pool, request.params.id)).map((s) => ({
        ...s,
        name: nameOf.get(s.sectionId) ?? s.sectionId,
      }));
      const preconditions = await nationalApprovalPreconditions(pool, request.params.id);
      const operatorNames = await getDisplayNamesByIdentifier(pool, [
        report.requestedBy ?? '',
        report.approvedBy ?? '',
      ]);
      return reply.send({ report, sections, preconditions, operatorNames });
    },
  );

  app.post(
    '/national-reports/:id/open',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      await openDraft(getPool(), request.params.id);
      return reply.send({ opened: true });
    },
  );

  app.post(
    '/national-reports/:id/request-approval',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ reason: z.string().min(10) }),
      },
    },
    async (request, reply) => {
      await requestNationalApproval(getPool(), request.params.id, {
        requestedBy: request.session.email,
        reason: request.body.reason,
      });
      return reply.send({ requested: true });
    },
  );

  app.post(
    '/national-reports/:id/approve',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({}).optional(),
      },
    },
    async (request, reply) => {
      // The approver is the signed-in operator, never a body field — see
      // routes/scoring.ts for why a client-supplied identity is refused.
      const report = await approveNational(getPool(), request.params.id, request.session.email);
      // Approval publishes the Industry report. Drafting its analysis can take a
      // minute, so it runs after the response; if it fails, the report screen
      // says so and offers to publish again.
      if (report.status === 'approved') {
        publishIndustryReport(
          getPool(),
          report.editionId,
          foundryModelFromEnv,
          request.session.email,
        ).catch((err: unknown) =>
          request.log.warn({ err }, 'Industry report not published on approval'),
        );
      }
      return reply.send({ status: report.status });
    },
  );

  // ── Firm reports (UX-ADM-006) ─────────────────────────────────────────────
  app.get(
    '/editions/:id/firm-reports',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const reports = await getFirmReports(getPool(), request.params.id);
      const emails = await listEmailsFor(
        getPool(),
        'firm-report-released',
        reports.map((r) => r.id),
      );
      // Per report: how its release notice went (sent / logged / failed).
      const notices: Record<
        string,
        { sent: number; logged: number; failed: number; queued: number }
      > = {};
      for (const e of emails) {
        const n = (notices[e.refId ?? ''] ??= { sent: 0, logged: 0, failed: 0, queued: 0 });
        n[e.status] += 1;
      }
      return reply.send({ reports, notices });
    },
  );

  app.post(
    '/editions/:id/firm-reports/generate',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ scoringRunId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const result = await generateFirmReports(getPool(), {
        editionId: request.params.id,
        scoringRunId: request.body.scoringRunId,
      });
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/firm-reports/:id/approve',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const report = await approveFirmReport(getPool(), request.params.id);
      return reply.send({ approvalState: report.approvalState });
    },
  );

  // Retry a failed/held report's generation. Never a released report — the DB
  // itself refuses any edit to one; a correction there is a new version.
  app.post(
    '/firm-reports/:id/regenerate',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const report = await regenerateFirmReport(getPool(), request.params.id);
      return reply.send({ report });
    },
  );

  // Atomic per-report release. Blocked until the national report is approved.
  app.post(
    '/editions/:id/firm-reports/release',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const pool = getPool();
      const editionId = request.params.id;
      // Each report goes out with its written analysis, frozen as released.
      const result = await releaseFirmReports(pool, editionId, {
        releasedBy: request.session.email,
        prepare: async (report) => {
          const narrative = await ensureFirmNarrative(
            pool,
            editionId,
            report.organizationId,
            foundryModelFromEnv,
            request.session.email,
          );
          if (!narrative) throw new Error('there are no figures to write about yet');
          return { narrativeId: narrative.id };
        },
      });
      // Then tell each released firm's coordinators. A notice never holds back
      // or undoes a release.
      let notified = { sent: 0, logged: 0, failed: 0 };
      try {
        await queueReleaseNotices(pool, result.released, portalUrl());
        notified = await deliverQueuedEmails(pool, request.log);
      } catch (err) {
        request.log.warn({ err }, 'Release notices could not be queued');
      }
      return reply.send({
        notified,
        released: result.released.map((r) => r.organizationId),
        held: result.held.map((h) => ({
          organizationId: h.report.organizationId,
          reason: h.reason,
        })),
      });
    },
  );
};
