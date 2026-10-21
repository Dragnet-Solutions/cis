import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiError, type Api } from '../src/api';
import { parseConfig } from '../src/config';
import { NO_INVITE_REASON, setupFirm, type FlowContext } from '../src/flows';
import {
  inviteResolver,
  inviteTokenFromLink,
  normalizeFirmName,
  parseCsvLine,
  parseFirmInvites,
} from '../src/invites';
import { buildPlan, DEFAULT_PLAN_OPTIONS, DEFAULT_TARGETS } from '../src/plan';
import { newState } from '../src/state';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';

describe('firm invitation links', () => {
  it('reads the Firm team CSV, matching firms by name', () => {
    const csv = [
      'firm,email,link,expires',
      `[Test] Alpha,coordinator+t-alpha@test.example,https://dev.example/firm?invite=${T1},2026-11-04T10:00:00.000Z`,
      `"[Test] Beta, Plc",coordinator+t-beta@test.example,https://dev.example/firm?invite=${T2},2026-11-04T10:00:00.000Z`,
      `'=Odd Name,x@test.example,https://dev.example/firm?invite=${T3},2026-11-04T10:00:00.000Z`,
      '',
    ].join('\r\n');
    const inv = parseFirmInvites(csv);
    expect(inv.unnamed).toEqual([]);
    expect(inv.byName.get('[test] alpha')).toBe(T1);
    expect(inv.byName.get('[test] beta, plc')).toBe(T2);
    expect(inv.byName.get('=odd name')).toBe(T3);
  });

  it('reads plain lines of links or bare tokens as unnamed', () => {
    const inv = parseFirmInvites(
      `# links\nhttps://dev.example/firm?invite=${T1}\nAlpha: https://x/firm?a=1&invite=${T2}\n${T3}\nnot a link\n${T1}\n`,
    );
    expect(inv.unnamed).toEqual([T1, T2, T3]);
    expect(inv.byName.size).toBe(0);
  });

  it('resolves a firm by id (looked-up links) before name', () => {
    const inv = parseFirmInvites(`firm,link\n[Test] Alpha,https://x/firm?invite=${T1}\n`);
    const resolve = inviteResolver(inv, new Map([['id-b', T2]]));
    expect(resolve({ id: 'id-a', name: '[Test]  ALPHA ' })).toBe(T1);
    expect(resolve({ id: 'id-b', name: '[Test] Beta' })).toBe(T2);
    expect(resolve({ id: 'id-c', name: '[Test] Gamma' })).toBeNull();
  });

  it('parses CSV cells and links', () => {
    expect(parseCsvLine('a,"b, c","d ""q"""')).toEqual(['a', 'b, c', 'd "q"']);
    expect(inviteTokenFromLink(`https://x/firm?invite=${T1}#top`)).toBe(T1);
    expect(inviteTokenFromLink('https://x/firm?claim=abc')).toBeNull();
    expect(normalizeFirmName("'+Plus  Firm")).toBe('+plus firm');
  });

  const dir = mkdtempSync(join(tmpdir(), 'robot-invites-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('--firm-invites loads the file', () => {
    const file = join(dir, 'firm-invitations.csv');
    writeFileSync(
      file,
      `firm,email,link,expires\n[Test] A,a@test.example,https://x/firm?invite=${T1},x\n`,
    );
    const config = parseConfig(['--dry-run', '--firm-invites', file], dir);
    if (config === 'help') throw new Error('unexpected help');
    expect(config.firmInvites.byName.get('[test] a')).toBe(T1);
    const none = parseConfig(['--dry-run'], dir);
    if (none === 'help') throw new Error('unexpected help');
    expect(none.firmInvites.byName.size).toBe(0);
  });
});

describe('claiming a firm (setupFirm)', () => {
  const firms = [{ id: 'firm-1', displayName: '[Test] One' }];
  const plan = buildPlan(firms, {
    ...DEFAULT_PLAN_OPTIONS,
    seed: 's',
    targets: { ...DEFAULT_TARGETS, firms: 1 },
  });

  function ctxWith(
    api: { post: (path: string) => Promise<unknown> },
    token: string | null,
  ): { ctx: FlowContext; posts: Array<{ path: string; body: unknown }> } {
    const posts: Array<{ path: string; body: unknown }> = [];
    const state = newState({ baseUrl: 'http://localhost', editionId: 'e', seed: 's', firms });
    const ctx: FlowContext = {
      api: {
        post: async (path: string, body?: unknown) => {
          posts.push({ path, body });
          return api.post(path);
        },
      } as unknown as Api,
      plan,
      state,
      editionId: 'e',
      save: () => undefined,
      thinkMs: () => 0,
      isStopping: () => false,
      log: () => undefined,
      inviteTokenFor: () => token,
    };
    return { ctx, posts };
  }

  it('sends the invitation token with the claim', async () => {
    const { ctx, posts } = ctxWith(
      {
        post: async (path: string) => {
          if (path === '/firm/claim') return { claim: { id: 'c' } };
          throw new ApiError(500, 'Stop', 'stop here', path);
        },
      },
      T1,
    );
    await expect(setupFirm(ctx, plan.firms[0]!)).rejects.toThrow(/stop here/);
    expect(posts[0]).toMatchObject({ path: '/firm/claim', body: { inviteToken: T1 } });
  });

  it('skips a firm with no invitation link, saying why', async () => {
    const { ctx, posts } = ctxWith(
      {
        post: async (path: string) => {
          if (path === '/firm/claim') {
            throw new ApiError(403, 'InvitationRequiredError', 'You need an invitation link', path);
          }
          throw new ApiError(401, 'InvalidCoordinatorCredentialsError', 'no', path);
        },
      },
      null,
    );
    const what = await setupFirm(ctx, plan.firms[0]!);
    expect(what).toBe(`skipped — ${NO_INVITE_REASON}`);
    expect((posts[0]!.body as Record<string, unknown>)['inviteToken']).toBeUndefined();
    const fs = ctx.state.firmState['firm-1']!;
    expect(fs.claim).toBe('pending');
    expect(fs.lastError).toMatch(/--firm-invites/);
  });

  it('reports a refused link (e.g. expired) as the skip reason', async () => {
    const { ctx } = ctxWith(
      {
        post: async (path: string) => {
          if (path === '/firm/claim') {
            throw new ApiError(409, 'FirmInvitationError', 'This invitation has expired.', path);
          }
          throw new ApiError(401, 'InvalidCoordinatorCredentialsError', 'no', path);
        },
      },
      T1,
    );
    expect(await setupFirm(ctx, plan.firms[0]!)).toMatch(/invitation link was refused.*expired/);
  });
});
