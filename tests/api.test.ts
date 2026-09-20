/** HTTP integration tests: the real app, real schema, mock provider, no network. */
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  GraphDto,
  IdeaDto,
  ItemDetailDto,
  ItemWithIdeaDto,
  SynthesisDto,
} from '../src/api-types';
import { createApp } from '../src/server/app';
import { PYRAMIDS_TEXT, testContext } from './helpers';

let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  app = createApp(await testContext());
});

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

describe('HTTP API', () => {
  it('walks the whole workflow: capture, analyse, review, synthesise, trace', async () => {
    const created = await call<IdeaDto>('POST', '/ideas', { text: PYRAMIDS_TEXT });
    expect(created.status).toBe(201);
    const ideaId = created.json.id;

    const analysed = await call<IdeaDto>('POST', `/ideas/${ideaId}/analyze`);
    expect(analysed.json.stage).toBe('in_review');
    expect(analysed.json.gate.canProceed).toBe(false);

    const blocked = await call<{ error: { code: string } }>(
      'POST',
      `/ideas/${ideaId}/synthesize`,
      {},
    );
    expect(blocked.status).toBe(409);

    const inbox = await call<ItemWithIdeaDto[]>('GET', `/inbox?ideaId=${ideaId}`);
    expect(inbox.json.length).toBe(6);
    for (const item of inbox.json) {
      const res = await call<ItemDetailDto>('POST', `/items/${item.id}/decisions`, {
        decision: 'qualify',
        qualification: 'Agreed, with limits.',
      });
      expect(res.status).toBe(201);
      expect(res.json.item.status).toBe('qualified');
    }

    const target = inbox.json[0]!;
    const talked = await call<ItemDetailDto>('POST', `/items/${target.id}/messages`, {
      body: 'Why does this matter?',
      askAgent: true,
    });
    expect(talked.json.messages.map((m) => m.author)).toEqual(['user', 'agent']);

    const synthesis = await call<SynthesisDto>('POST', `/ideas/${ideaId}/synthesize`, {});
    expect(synthesis.status).toBe(200);
    expect(synthesis.json.body.conclusions.length).toBeGreaterThan(0);
    const known = new Set(synthesis.json.referencedItems.map((i) => i.id));
    for (const c of synthesis.json.body.conclusions)
      for (const ref of c.refs) expect(known.has(ref)).toBe(true);

    const graph = await call<GraphDto>('GET', `/ideas/${ideaId}/graph`);
    expect(graph.json.nodes.some((n) => n.kind === 'synthesis')).toBe(true);
    const nodeIds = new Set(graph.json.nodes.map((n) => n.id));
    expect(
      graph.json.edges.every((e) => nodeIds.has(e.fromItemId) && nodeIds.has(e.toItemId)),
    ).toBe(true);
  });

  it('validates request bodies and maps domain errors to status codes', async () => {
    expect((await call('POST', '/ideas', { text: '' })).status).toBe(400);
    expect((await call('GET', '/ideas/idea_missing')).status).toBe(404);
    expect((await call('GET', '/nope')).status).toBe(404);

    const idea = (await call<IdeaDto>('POST', '/ideas', { text: 'A thought.' })).json;
    const root = idea.rootItemId;
    const res = await call<{ error: { message: string } }>('POST', `/items/${root}/decisions`, {
      decision: 'reject',
    });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toMatch(/cannot be decided on/);
    expect(
      (await call('POST', `/items/${root}/decisions`, { decision: 'obliterate' })).status,
    ).toBe(400);
    expect(
      (await call('POST', `/items/${root}/split`, { children: [{ text: 'only one' }] })).status,
    ).toBe(400);
    expect((await call('POST', `/ideas/${idea.id}/synthesize`, {})).status).toBe(409);
  });

  it('reports the provider so the UI can show demo mode', async () => {
    const meta = await call<{ provider: string; live: boolean }>('GET', '/meta');
    expect(meta.json).toMatchObject({ provider: 'mock', live: false });
  });
});
