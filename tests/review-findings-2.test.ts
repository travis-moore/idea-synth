/**
 * Regression tests for the second adversarial review (multi-client change set). Each of
 * these was reproduced by the reviewer against the real schema before it was fixed.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runCommand } from '../src/agent-api/commands';
import type { GenerateOptions } from '../src/ai/provider';
import type { StructuredRequest } from '../src/ai';
import {
  ClaudeCodeCliProvider,
  type ChildLike,
  type SpawnLike,
} from '../src/ai/providers/claude-cli';
import { openTestDb } from '../src/db/client';
import type { Db } from '../src/db/schema';
import { createApp } from '../src/server/app';
import { guard, localSecurity } from '../src/server/security';
import {
  getGuidedSession,
  recordPremiseResponse,
  replyToTutor,
  startGuidedSession,
} from '../src/services/guided';
import { decide } from '../src/services/items';
import { enqueueJob, getJob, JobRunner } from '../src/services/jobs';
import { runSynthesis } from '../src/services/pipeline';
import { getGraph, getItemDetail, getSynthesis, listIdeaItems } from '../src/services/queries';
import { Hono } from 'hono';
import {
  analysedPyramids,
  itemByKey,
  overrideAll,
  PYRAMIDS_TEXT,
  testContext,
  TestProvider,
} from './helpers';

let db: Db;
let n = 0;
const meta = (extra: object = {}) => ({ requestId: `rf2-${++n}-abcdef`, agent: 'codex', ...extra });
const run = <T = Record<string, unknown>>(name: string, input: object) =>
  runCommand({ db }, name, input) as Promise<T>;
beforeEach(async () => {
  db = await openTestDb();
});

describe('request ids identify a request, not just an operation name', () => {
  it('refuses a reused id carrying a different answer instead of silently dropping it', async () => {
    const { sessionId } = await run<{ sessionId: string }>('guided.start', {
      meta: meta(),
      hypothesis: 'Maybe robots will mean nobody has to work.',
    });
    const ctx = { db, provider: new TestProvider() };
    const { advanceSession } = await import('../src/services/guided');
    await advanceSession(ctx, sessionId);
    const m = meta();
    await run('guided.answer', { meta: m, sessionId, body: "I don't know" });
    expect(
      (
        await run<{ replayed: boolean }>('guided.answer', {
          meta: m,
          sessionId,
          body: "I don't know",
        })
      ).replayed,
    ).toBe(true);
    await advanceSession(ctx, sessionId);
    // Same id, different words: refused, not "ok".
    await expect(
      run('guided.answer', { meta: m, sessionId, body: 'Actually: robots must do every job.' }),
    ).rejects.toMatchObject({
      details: { reason: 'request_id_reused' },
    });
    const answers = (await getGuidedSession(db, sessionId)).steps.filter(
      (s) => s.stepKind === 'answer',
    );
    expect(answers.map((a) => a.body)).toEqual(["I don't know"]);
  });

  it("does not answer one idea with another idea's result", async () => {
    const m = meta();
    const first = await run<{ ideaId: string }>('ideas.capture', {
      meta: m,
      text: 'First idea.',
      author: 'user',
    });
    await expect(
      run('ideas.capture', { meta: m, text: 'A different idea.', author: 'user' }),
    ).rejects.toThrow(/DIFFERENT request/);
    expect(
      (
        await run<{ ideaId: string; replayed: boolean }>('ideas.capture', {
          meta: m,
          text: 'First idea.',
          author: 'user',
        })
      ).ideaId,
    ).toBe(first.ideaId);
  });

  it('applies the same rule to job request ids', async () => {
    const ctx = await testContext();
    const a = await analysedPyramids(ctx);
    await enqueueJob(ctx, {
      ideaId: a.id,
      payload: { kind: 'synthesize', baseVersion: 0 },
      requestId: 'job-req-0001',
    });
    await expect(
      enqueueJob(ctx, { ideaId: a.id, payload: { kind: 'analyze' }, requestId: 'job-req-0001' }),
    ).rejects.toThrow(/different job/);
  });
});

describe("an agent cannot put its words under the user's name", () => {
  it('requires the author of a reframing, keeps it exact, and never defaults it to the user', async () => {
    const ctx = { db, provider: new TestProvider() };
    const idea = await analysedPyramids(ctx);
    const tangent = await itemByKey(ctx, idea.id, 'x_games');
    const m = { userInstruction: 'yes make that its own idea' };
    await expect(
      run('items.promote', { meta: meta(m), itemId: tangent.id, framing: 'Games as ritual war.' }),
    ).rejects.toThrow(/framingAuthor/);
    const promoted = await run<{ result: { ideaId: string } }>('items.promote', {
      meta: meta(m),
      itemId: tangent.id,
      framing: ' Games as ritual war. ',
      framingAuthor: 'agent',
    });
    expect((await listIdeaItems(db, promoted.result.ideaId))[0]).toMatchObject({
      origin: 'agent',
      text: ' Games as ritual war. ',
    });
  });

  it('will not reword the user\'s item as "user" without the user\'s instruction', async () => {
    const ctx = { db, provider: new TestProvider() };
    const idea = await analysedPyramids(ctx);
    const mine = await itemByKey(ctx, idea.id, 'e_hypothesis');
    await expect(
      run('items.revise', {
        meta: meta(),
        itemId: mine.id,
        text: 'Agent wording.',
        author: 'user',
      }),
    ).rejects.toThrow(/Only the user can reword/);
    await run('items.revise', {
      meta: meta({ userInstruction: 'change it to: hard projects sometimes build skills' }),
      itemId: mine.id,
      text: 'Hard projects sometimes build skills.',
      author: 'user',
    });
    const detail = await getItemDetail(db, mine.id);
    expect(detail.events.at(-1)).toMatchObject({
      type: 'item.revised',
      payload: { relayedBy: 'codex' },
    });
    expect(detail.events.at(-1)!.operation!.userInstruction).toMatch(/change it to/);
  });

  it('never stores application-written text as a user step', async () => {
    const ctx = { db, provider: new TestProvider() };
    const sessionId = await startGuidedSession(ctx, {
      hypothesis: 'Maybe robots will mean nobody has to work.',
    });
    for (let i = 0; i < 4; i++) await replyToTutor(ctx, sessionId, { body: 'no idea' });
    const premiseId = (await getGuidedSession(db, sessionId)).steps.at(-1)!.itemId!;
    await decide(db, premiseId, { decision: 'accept' }); // handled from the item panel
    await recordPremiseResponse(db, sessionId, { stance: 'accept' });
    const note = (await getGuidedSession(db, sessionId)).steps.find(
      (s) => s.stepKind === 'premise_response',
    )!;
    expect(note).toMatchObject({ author: 'agent', stance: 'accept' });
    expect(note.body).toMatch(/System note/);

    const second = await startGuidedSession(ctx, {
      hypothesis: 'Maybe robots will mean nobody has to work. (2)',
    });
    for (let i = 0; i < 4; i++) await replyToTutor(ctx, second, { body: 'no idea' });
    await recordPremiseResponse(db, second, { stance: 'reject' });
    expect(
      (await getGuidedSession(db, second)).steps.find((s) => s.stepKind === 'premise_response'),
    ).toMatchObject({ author: 'user', body: '', stance: 'reject' });
  });

  it('passes.next writes nothing, and a guided idea cannot enter analysis past an unanswered premise', async () => {
    const ctx = { db, provider: new TestProvider() };
    const sessionId = await startGuidedSession(ctx, {
      hypothesis: 'Maybe robots will mean nobody has to work.',
    });
    const { ideaId } = await getGuidedSession(db, sessionId);
    const before = (await getGuidedSession(db, sessionId)).inputVersion;
    await run('passes.next', { ideaId });
    expect((await getGuidedSession(db, sessionId)).inputVersion).toBe(before);

    for (let i = 0; i < 4; i++) await replyToTutor(ctx, sessionId, { body: 'no idea' });
    await expect(run('passes.next', { ideaId })).rejects.toThrow(/Respond to the premise/);
    const app = createApp(ctx, { security: 'disabled-for-tests' });
    await app.request(`/api/ideas/${ideaId}/analyze`, { method: 'POST' });
    await new JobRunner(ctx, { pollMs: 5 }).drain();
    expect(
      (await getGraph(db, ideaId)).nodes.some((node) => node.createdByPass === 'extract'),
    ).toBe(false);
  });
});

describe('replies and resumed jobs', () => {
  /** Lets a test post a second message while the first reply is being "written". */
  class SlowReplies extends TestProvider {
    sawThreads: number[] = [];
    onFirstReply: (() => Promise<void>) | null = null;
    override async generate<T>(
      request: StructuredRequest<T>,
      _options?: GenerateOptions,
    ): Promise<unknown> {
      if (request.pass === 'discuss') {
        this.sawThreads.push((request.input as { thread: unknown[] }).thread.length);
        const hook = this.onFirstReply;
        this.onFirstReply = null;
        await hook?.();
      }
      return this.inner.generate(request);
    }
  }

  it("never lands a reply that did not see the user's latest message, and still answers it", async () => {
    const provider = new SlowReplies();
    const ctx = { db, provider };
    const idea = await analysedPyramids(ctx);
    const item = await itemByKey(ctx, idea.id, 'a_selection');
    const app = createApp(ctx, { security: 'disabled-for-tests' });
    const post = (body: string) =>
      app.request(`/api/items/${item.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, askAgent: true }),
      });
    provider.onFirstReply = async () => void (await post('actually I changed my mind'));
    await post('first thought');
    await new JobRunner(ctx, { pollMs: 5 }).drain();

    const thread = (await getItemDetail(db, item.id)).messages;
    expect(thread.map((m) => m.author)).toEqual(['user', 'user', 'agent']);
    // The reply that landed was written with BOTH messages in view.
    expect(provider.sawThreads.at(-1)).toBe(2);
    expect(thread.at(-1)!.body).toContain('changed my mind');
  });

  it('does not build a second synthesis when a finished synthesize job is resumed', async () => {
    const ctx = { db, provider: new TestProvider() };
    const idea = await analysedPyramids(ctx);
    const { override } = await overrideAll(ctx, idea.id);
    const job = await enqueueJob(ctx, {
      ideaId: idea.id,
      payload: { kind: 'synthesize', override, baseVersion: 0 },
    });
    await new JobRunner(ctx, { pollMs: 5, workerId: 'first' }).drain();
    expect((await getSynthesis(db, idea.id))!.version).toBe(1);
    // Simulate a crash after the commit but before the status write.
    await db
      .updateTable('jobs')
      .set({
        status: 'running',
        worker_id: 'dead',
        heartbeat_at: new Date(Date.now() - 120_000).toISOString(),
      })
      .where('id', '=', job.id)
      .execute();
    await new JobRunner(ctx, { pollMs: 5, workerId: 'second' }).drain();
    expect((await getJob(db, job.id)).status).toBe('completed');
    expect((await getSynthesis(db, idea.id))!.version).toBe(1);
    await runSynthesis(ctx, idea.id, { override });
    expect((await getSynthesis(db, idea.id))!.version).toBe(2); // an explicit re-run still works
  });
});

describe('claude-cli adapter output', () => {
  it('decodes multibyte characters that straddle a chunk boundary', async () => {
    const envelope = Buffer.from(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: '',
        structured_output: { t: '日本語のテキスト — “quoted”' },
      }),
    );
    const cut = envelope.indexOf(Buffer.from('本')) + 1; // inside the 3-byte character
    let launches = 0;
    const spawn: SpawnLike = () => {
      const child = new EventEmitter() as EventEmitter & ChildLike;
      const stdout = new EventEmitter();
      const first = launches++ === 0;
      Object.assign(child, {
        stdout,
        stderr: new EventEmitter(),
        kill: () => true,
        stdin: {
          on: () => undefined,
          end: () =>
            setImmediate(() => {
              if (first)
                stdout.emit(
                  'data',
                  Buffer.from(
                    JSON.stringify({
                      loggedIn: true,
                      authMethod: 'claude.ai',
                      apiProvider: 'firstParty',
                    }),
                  ),
                );
              else {
                stdout.emit('data', envelope.subarray(0, cut));
                stdout.emit('data', envelope.subarray(cut));
              }
              child.emit('close', 0, null);
            }),
        },
      });
      return child;
    };
    const out = await new ClaudeCodeCliProvider({ spawn, env: {} }).generate({
      pass: 'discuss',
      task: 't',
      promptVersion: 'v',
      system: 's',
      prompt: 'p',
      input: {},
      schema: z.object({ t: z.string() }),
    });
    expect(out).toEqual({ t: '日本語のテキスト — “quoted”' });
  });
});

describe('forged headers from another machine', () => {
  it('cannot obtain the token or change state unless the connection comes from loopback', async () => {
    const security = localSecurity('t'.repeat(64), 8787);
    const app = new Hono<{ Bindings: { incoming: { socket: { remoteAddress: string } } } }>();
    app.use('*', guard(security));
    app.get('/api/session', (c) => c.json({ token: security.token }));
    app.get('/api/ideas', (c) => c.json([]));
    const from = (remoteAddress: string, path: string) =>
      app.request(
        path,
        { headers: { host: 'localhost:8787' } },
        { incoming: { socket: { remoteAddress } } },
      );
    expect((await from('192.168.1.50', '/api/session')).status).toBe(403);
    expect((await from('127.0.0.1', '/api/session')).status).toBe(200);
    expect((await from('::ffff:127.0.0.1', '/api/session')).status).toBe(200);
    expect((await from('192.168.1.50', '/api/ideas')).status).toBe(200); // reads only, and only if HOST was opened on purpose
    expect(PYRAMIDS_TEXT.length).toBeGreaterThan(0);
  });
});
