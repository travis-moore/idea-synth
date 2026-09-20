/** HTTP integration tests: the real app, real schema, mock provider, durable jobs, no network. */
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ChangesDto,
  GraphDto,
  GuidedSessionDto,
  IdeaDto,
  ItemDetailDto,
  ItemWithIdeaDto,
  JobDto,
  SynthesisDto,
} from '../src/api-types';
import { NoProvider } from '../src/ai';
import { openTestDb } from '../src/db/client';
import { createApp } from '../src/server/app';
import { localSecurity, TOKEN_HEADER } from '../src/server/security';
import type { AppContext } from '../src/services/context';
import { JobRunner } from '../src/services/jobs';
import { PYRAMIDS_TEXT, testContext } from './helpers';

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let runner: JobRunner;
beforeEach(async () => {
  ctx = await testContext();
  runner = new JobRunner(ctx, { pollMs: 5 });
  app = createApp(ctx, { security: 'disabled-for-tests' });
});

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

describe('HTTP API', () => {
  it('walks the whole workflow with reasoning done by durable jobs', async () => {
    const created = await call<IdeaDto>('POST', '/ideas', { text: PYRAMIDS_TEXT });
    expect(created.status).toBe(201);
    const ideaId = created.json.id;

    const queued = await call<JobDto>('POST', `/ideas/${ideaId}/analyze`);
    expect(queued.status).toBe(202);
    expect(queued.json).toMatchObject({ kind: 'analyze', status: 'queued' });
    // Asking again while it is queued does not pile up a second job.
    expect((await call<JobDto>('POST', `/ideas/${ideaId}/analyze`)).json.id).toBe(queued.json.id);
    await runner.drain();
    expect((await call<JobDto>('GET', `/jobs/${queued.json.id}`)).json.status).toBe('completed');
    expect((await call<IdeaDto>('GET', `/ideas/${ideaId}`)).json.stage).toBe('in_review');

    const blocked = await call<{ error: { details: { blockingItemIds: string[] } } }>(
      'POST',
      `/ideas/${ideaId}/synthesize`,
      {},
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details.blockingItemIds).toHaveLength(6);

    const inbox = await call<ItemWithIdeaDto[]>('GET', `/inbox?ideaId=${ideaId}`);
    for (const item of inbox.json) {
      const res = await call<ItemDetailDto>('POST', `/items/${item.id}/decisions`, {
        decision: 'qualify',
        qualification: 'Agreed, with limits.',
      });
      expect(res.json.item.status).toBe('qualified');
      expect(res.json.events.at(-1)!.operation).toMatchObject({
        client: 'web',
        executedBy: 'user',
      });
    }

    const target = inbox.json[0]!;
    const talked = await call<{ detail: ItemDetailDto; job: JobDto }>(
      'POST',
      `/items/${target.id}/messages`,
      {
        body: '  Why does this matter?  ',
        askAgent: true,
      },
    );
    // The user's message is already stored, exactly, before the reply job has run.
    expect(talked.json.detail.messages.map((m) => [m.author, m.body])).toEqual([
      ['user', '  Why does this matter?  '],
    ]);
    await runner.drain();
    const thread = (await call<ItemDetailDto>('GET', `/items/${target.id}`)).json.messages;
    expect(thread.map((m) => m.author)).toEqual(['user', 'agent']);

    expect((await call<JobDto>('POST', `/ideas/${ideaId}/synthesize`, {})).status).toBe(202);
    await runner.drain();
    const synthesis = (await call<SynthesisDto>('GET', `/ideas/${ideaId}/synthesis`)).json;
    expect(synthesis.body.conclusions.length).toBeGreaterThan(0);
    const graph = await call<GraphDto>('GET', `/ideas/${ideaId}/graph`);
    expect(graph.json.nodes.some((n) => n.kind === 'synthesis')).toBe(true);
  });

  it('binds a web override to the items the user was shown', async () => {
    const ideaId = (await call<IdeaDto>('POST', '/ideas', { text: PYRAMIDS_TEXT })).json.id;
    await call('POST', `/ideas/${ideaId}/analyze`);
    await runner.drain();
    const shown = (await call<ItemWithIdeaDto[]>('GET', `/inbox?ideaId=${ideaId}`)).json.map(
      (i) => i.id,
    );
    const partial = await call('POST', `/ideas/${ideaId}/synthesize`, {
      overrideBlockingItemIds: shown.slice(1),
    });
    expect(partial.status).toBe(409);
    expect(
      (await call('POST', `/ideas/${ideaId}/synthesize`, { overrideBlockingItemIds: shown }))
        .status,
    ).toBe(202);
    await runner.drain();
    expect((await call<SynthesisDto>('GET', `/ideas/${ideaId}/synthesis`)).json.version).toBe(1);
  });

  it('runs a guided turn as a job, with the answer stored first', async () => {
    const started = await call<GuidedSessionDto>('POST', '/guided', {
      hypothesis: 'Maybe robots will mean nobody has to work.',
    });
    expect(started.json.pendingTask).toBe('move');
    await runner.drain();
    const sessionId = started.json.id;
    const replied = await call<GuidedSessionDto>('POST', `/guided/${sessionId}/reply`, {
      body: " I don't know ",
    });
    expect(replied.json.steps.at(-1)).toMatchObject({
      stepKind: 'answer',
      body: " I don't know ",
      adequacy: null,
    });
    expect(replied.json.pendingTask).toBe('assessment');
    await runner.drain();
    const after = (await call<GuidedSessionDto>('GET', `/guided/${sessionId}`)).json;
    expect(after).toMatchObject({ level: 2, pendingTask: 'answer' });
  });

  it('exposes a change feed the live view can poll', async () => {
    const idea = (await call<IdeaDto>('POST', '/ideas', { text: 'A thought.' })).json;
    const before = (await call<ChangesDto>('GET', '/changes')).json.ideas[idea.id]!;
    await call('POST', `/items/${idea.rootItemId}/branch`, { text: 'A branch.' });
    const after = (await call<ChangesDto>('GET', '/changes')).json;
    expect(after.ideas[idea.id]).toBeGreaterThan(before);
    expect(after.activeJobs).toBe(0);
  });

  it('validates request bodies and maps domain errors to status codes', async () => {
    expect((await call('POST', '/ideas', { text: '   ' })).status).toBe(400);
    expect((await call('GET', '/ideas/idea_missing')).status).toBe(404);
    expect((await call('GET', '/nope')).status).toBe(404);
    const idea = (await call<IdeaDto>('POST', '/ideas', { text: 'A thought.' })).json;
    const res = await call<{ error: { message: string } }>(
      'POST',
      `/items/${idea.rootItemId}/decisions`,
      { decision: 'reject' },
    );
    expect(res.status).toBe(400);
    expect(res.json.error.message).toMatch(/cannot be decided on/);
    expect(
      (await call('POST', `/items/${idea.rootItemId}/split`, { children: [{ text: 'only one' }] }))
        .status,
    ).toBe(400);
    expect((await call('POST', `/ideas/${idea.id}/synthesize`, {})).status).toBe(409);
  });
});

describe('viewer mode', () => {
  it('serves and reviews everything without a provider, but will not queue reasoning', async () => {
    const viewer = createApp(
      { db: await openTestDb(), provider: new NoProvider() },
      { security: 'disabled-for-tests' },
    );
    const req = (method: string, path: string, body?: unknown) =>
      viewer.request(`/api${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect(await (await req('GET', '/meta')).json()).toMatchObject({
      provider: 'none',
      canReason: false,
    });
    const idea = (await (
      await req('POST', '/ideas', { text: 'Captured in viewer mode.' })
    ).json()) as IdeaDto;
    expect((await req('GET', `/ideas/${idea.id}/graph`)).status).toBe(200);
    const refused = await req('POST', `/ideas/${idea.id}/analyze`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(
      /VS Code agent/,
    );
  });
});

describe('local request protection', () => {
  const security = localSecurity('t'.repeat(64), 8787);
  const secured = () => createApp(ctx, { security });
  const send = (method: string, headers: Record<string, string>) =>
    secured().request('/api/ideas', {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: method === 'POST' ? JSON.stringify({ text: 'x' }) : undefined,
    });

  it('answers only on its own loopback host (DNS rebinding)', async () => {
    expect((await send('GET', { host: 'localhost:8787' })).status).toBe(200);
    expect((await send('GET', { host: 'evil.example:8787' })).status).toBe(403);
    expect((await send('GET', {})).status).toBe(403);
  });

  it('refuses cross-site requests and state changes without the session token', async () => {
    const host = { host: '127.0.0.1:8787' };
    expect(
      (
        await send('POST', {
          ...host,
          origin: 'https://evil.example',
          [TOKEN_HEADER]: security.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send('POST', {
          ...host,
          'sec-fetch-site': 'cross-site',
          [TOKEN_HEADER]: security.token,
        })
      ).status,
    ).toBe(403);
    expect((await send('POST', host)).status).toBe(401);
    expect((await send('POST', { ...host, [TOKEN_HEADER]: 'wrong' })).status).toBe(401);
    expect(
      (
        await send('POST', {
          ...host,
          origin: 'http://localhost:5173',
          [TOKEN_HEADER]: security.token,
        })
      ).status,
    ).toBe(201);
  });
});
