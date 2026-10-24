import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool, getEmailById, getOutboxHealth } from '@cis/db';
import { loadRbacContext, requirePermission } from '@cis/auth';
import { writeAudit } from '@cis/audit';
import { queueNotice } from '@cis/domain';
import { STUDY_NAME } from '@cis/survey';
import { isMailDispatcherRunning, kickMailDispatcher } from '../mail/dispatcher';
import { deliverDueEmails } from '../mail/mailer';
import { transportKind } from '../mail/select-transport';
import { parseAddress } from '../mail/transport';
import { DEFAULT_ZEPTOMAIL_API_URL } from '../mail/zeptomail';

/**
 * Mail health for operators. GET /mail/status says which mail service this
 * server sends through (or that it sends nothing — notices are only recorded),
 * and how the outbox stands. POST /mail/test sends one test email and reports
 * what happened to it. No secret is ever returned: only the sender address,
 * the API host, and whether a webhook secret is set.
 */

export const MAIL_TEST_EMAIL_KIND = 'mail-test';
const TEST_WAIT_MS = 10_000;
const POLL_MS = 250;

/** `traore@outlook.com` → `tr***@outlook.com`: enough to recognise, not to harvest. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}***${address.slice(at)}`;
}

function hostOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).host || null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const mailRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/mail/status', { preHandler: [app.authenticate] }, async (_request, reply) => {
    const env = process.env;
    const transport = transportKind(env);
    const health = await getOutboxHealth(getPool(), { days: 7, failures: 10 });
    return reply.send({
      transport,
      from: parseAddress(env['MAIL_FROM'])?.address ?? null,
      apiHost:
        transport === 'zeptomail'
          ? hostOf(env['ZEPTOMAIL_API_URL'] || DEFAULT_ZEPTOMAIL_API_URL)
          : transport === 'smtp'
            ? hostOf(env['SMTP_URL'])
            : null,
      webhookConfigured: !!env['ZEPTOMAIL_WEBHOOK_SECRET']?.trim(),
      dispatcherRunning: isMailDispatcherRunning(),
      outbox: health.counts,
      oldestQueuedAt: health.oldestQueuedAt,
      recentFailures: health.recentFailures.map((f) => ({
        kind: f.kind,
        to: maskAddress(f.to),
        error: f.error,
        at: f.at,
      })),
      recentLogged: health.recentLogged,
    });
  });

  app.post(
    '/mail/test',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 5, timeWindow: 60_000 } },
      schema: { body: z.object({ to: z.string().trim().email() }) },
    },
    async (request, reply) => {
      const pool = getPool();
      const actorId = request.session.sub;
      requirePermission(await loadRbacContext(pool, actorId), 'access:send');

      const queued = await queueNotice(pool, {
        kind: MAIL_TEST_EMAIL_KIND,
        audience: 'operator',
        label: 'Test',
        refId: null,
        to: request.body.to,
        subject: `${STUDY_NAME}: test email`,
        heading: 'Test email',
        paragraphs: [
          `This is a test email from the ${STUDY_NAME} operations site.`,
          `It was sent by ${request.session.displayName} to check that email is working. ` +
            'No action is needed.',
        ],
      });
      await writeAudit(pool, {
        actorId,
        actionType: 'mail.test_sent',
        entityType: 'email_outbox',
        entityId: queued.id,
        newValue: { to: maskAddress(request.body.to) },
      });

      // The background dispatcher sends it within moments; where none runs in
      // this process, send it here so the answer is still real.
      if (isMailDispatcherRunning()) kickMailDispatcher();
      else await deliverDueEmails(pool, request.log);

      const deadline = Date.now() + TEST_WAIT_MS;
      let email = await getEmailById(pool, queued.id);
      while (email && email.status === 'queued' && !email.error && Date.now() < deadline) {
        await sleep(POLL_MS);
        email = await getEmailById(pool, queued.id);
      }

      const status = email?.status ?? 'queued';
      return reply.send({
        emailId: queued.id,
        status,
        // queued with an error = a transient refusal; it will be retried.
        retrying: status === 'queued' && !!email?.error,
        provider: email?.provider ?? null,
        providerMessageId: email?.providerMessageId ?? null,
        error: email?.error ?? null,
      });
    },
  );
};
