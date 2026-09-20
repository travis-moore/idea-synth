import { describe, expect, it } from 'vitest';
import { ProviderError, type StructuredRequest } from '../src/ai';
import type { GenerateOptions } from '../src/ai/provider';
import { openTestDb } from '../src/db/client';
import { captureIdea } from '../src/services/ideas';
import { enqueueJob, getJob, JobRunner, requestCancel } from '../src/services/jobs';
import { getIdea, listIdeaItems, listRuns } from '../src/services/queries';
import { PYRAMIDS_TEXT, TestProvider } from './helpers';

/** Hangs on one pass until aborted, like a model call that never returns. */
class Hanging extends TestProvider {
  started: string[] = [];
  constructor(private hangOn: string | null) {
    super();
  }
  release() {
    this.hangOn = null;
  }
  override generate<T>(
    request: StructuredRequest<T>,
    options: GenerateOptions = {},
  ): Promise<unknown> {
    this.started.push(request.pass);
    if (request.pass !== this.hangOn) return this.inner.generate(request);
    return new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () =>
        reject(
          options.signal!.reason instanceof Error
            ? options.signal!.reason
            : new ProviderError('aborted', { code: 'cancelled' }),
        ),
      );
    });
  }
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not reached');
};

describe('durable jobs', () => {
  it('times out a hung worker, keeps what landed, and can be run again', async () => {
    const provider = new Hanging('explore');
    const ctx = { db: await openTestDb(), provider };
    const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
    const runner = new JobRunner(ctx, { pollMs: 5 });
    const job = await enqueueJob(ctx, {
      ideaId: idea.id,
      payload: { kind: 'analyze' },
      timeoutMs: 60,
    });
    await runner.drain();

    expect(await getJob(ctx.db, job.id)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect((await listRuns(ctx.db, idea.id)).map((r) => [r.pass, r.status])).toEqual([
      ['extract', 'completed'],
      ['explore', 'failed'],
    ]);

    provider.release();
    await enqueueJob(ctx, { ideaId: idea.id, payload: { kind: 'analyze' } });
    await runner.drain();
    expect((await getIdea(ctx.db, idea.id)).stage).toBe('in_review');
    // The extract pass was not repeated.
    expect(
      (await listIdeaItems(ctx.db, idea.id)).filter((i) => i.createdByPass === 'extract'),
    ).toHaveLength(6);
  });

  it('cancels a running job and aborts the provider call', async () => {
    const provider = new Hanging('extract');
    const ctx = { db: await openTestDb(), provider };
    const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
    const runner = new JobRunner(ctx, { pollMs: 5, heartbeatMs: 10 });
    const job = await enqueueJob(ctx, { ideaId: idea.id, payload: { kind: 'analyze' } });
    runner.start();
    await until(
      async () =>
        (await getJob(ctx.db, job.id)).status === 'running' && provider.started.length > 0,
    );
    await requestCancel(ctx.db, job.id);
    await until(async () => (await getJob(ctx.db, job.id)).status === 'cancelled');
    await runner.stop();
    expect((await getJob(ctx.db, job.id)).errorCode).toBe('cancelled');
    expect((await getIdea(ctx.db, idea.id)).stage).toBe('captured');

    const queued = await enqueueJob(ctx, { ideaId: idea.id, payload: { kind: 'analyze' } });
    expect((await requestCancel(ctx.db, queued.id)).status).toBe('cancelled');
    await expect(requestCancel(ctx.db, queued.id)).rejects.toThrow(/already cancelled/);
  });

  it('resumes a job that was running when the server died', async () => {
    const dying = new Hanging('epistemic');
    const db = await openTestDb();
    const idea = await captureIdea(db, { text: PYRAMIDS_TEXT });
    const first = new JobRunner(
      { db, provider: dying },
      { pollMs: 5, workerId: 'worker-that-dies' },
    );
    const job = await enqueueJob(
      { db, provider: dying },
      { ideaId: idea.id, payload: { kind: 'analyze' } },
    );
    first.start();
    await until(async () => dying.started.includes('epistemic'));
    // Simulate a crash: the process is gone, the row still says "running".
    await first.stop();
    expect((await getJob(db, job.id)).status).toBe('running');
    await db
      .updateTable('jobs')
      .set({ heartbeat_at: new Date(Date.now() - 120_000).toISOString() })
      .execute();

    const restarted = new JobRunner(
      { db, provider: new TestProvider() },
      { pollMs: 5, workerId: 'new-process' },
    );
    expect(await restarted.recover()).toBe(1);
    await restarted.drain();
    expect(await getJob(db, job.id)).toMatchObject({ status: 'completed', attempts: 2 });
    expect((await getIdea(db, idea.id)).stage).toBe('in_review');
    const completed = (await listRuns(db, idea.id))
      .filter((r) => r.status === 'completed')
      .map((r) => r.pass);
    expect(completed).toEqual(['extract', 'explore', 'epistemic', 'adversarial']);
  });

  it('runs at most one job per idea at a time, and is idempotent on request id', async () => {
    const provider = new Hanging('extract');
    const ctx = { db: await openTestDb(), provider };
    const a = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
    const runner = new JobRunner(ctx, { pollMs: 5, concurrency: 4 });
    const job = await enqueueJob(ctx, {
      ideaId: a.id,
      payload: { kind: 'analyze' },
      requestId: 'req-analyze-1',
    });
    expect(
      (
        await enqueueJob(ctx, {
          ideaId: a.id,
          payload: { kind: 'analyze' },
          requestId: 'req-analyze-1',
        })
      ).id,
    ).toBe(job.id);
    const second = await enqueueJob(ctx, { ideaId: a.id, payload: { kind: 'synthesize' } });
    runner.start();
    await until(async () => (await getJob(ctx.db, job.id)).status === 'running');
    await new Promise((r) => setTimeout(r, 30));
    expect((await getJob(ctx.db, second.id)).status).toBe('queued');
    await runner.stop();
  });
});
