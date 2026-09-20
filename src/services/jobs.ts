/**
 * Durable, SQLite-backed jobs for web-triggered agent work.
 *
 * A job is a request to do some reasoning outside the HTTP request that asked for it:
 * closing the browser, or restarting the server, loses nothing. The `jobs` table is
 * MUTABLE operational state (status, progress, heartbeat) and is deliberately separate
 * from the append-only reasoning history: a job never *is* provenance, it only causes
 * passes to run, and those record themselves (`analysis_runs`, `operations`, `events`).
 *
 * Safety properties:
 *   - only a fixed set of job kinds exists; a job can never carry a command to execute
 *   - bounded concurrency, and at most one running job per idea
 *   - every handler is resumable/idempotent, so re-running after a crash is safe; the
 *     passes themselves refuse stale or duplicate output (input versions, pass order)
 *   - timeouts and cancellation abort the provider call (and kill any child process)
 */
import type { Selectable } from 'kysely';
import type { JobDto } from '../api-types';
import { ProviderError } from '../ai/provider';
import type { Db, JobKind, JobsTable, JobStatus } from '../db/schema';
import { conflict, DomainError, notFound } from '../domain/errors';
import { newId } from '../domain/ids';
import type { GateOverride } from './apply';
import type { AppContext } from './context';
import { advanceSession, handOffToSynthesis } from './guided';
import { requestAgentReply } from './items';
import { runAnalysis, runSynthesis, type PassOptions } from './pipeline';
import { nowIso, requireIdea } from './store';

type JobRow = Selectable<JobsTable>;

export type JobPayload =
  | { kind: 'analyze' }
  | { kind: 'synthesize'; override?: GateOverride | undefined }
  | { kind: 'discuss_reply'; itemId: string }
  | { kind: 'guided_turn'; sessionId: string }
  | { kind: 'guided_handoff'; sessionId: string };

const ACTIVE: readonly JobStatus[] = ['queued', 'running'];
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
/** A running job whose worker has not been heard from for this long is presumed dead. */
const HEARTBEAT_STALE_MS = 45_000;

export function toJobDto(row: JobRow): JobDto {
  const payload = JSON.parse(row.payload_json) as { itemId?: string; sessionId?: string };
  return {
    id: row.id,
    ideaId: row.idea_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    errorCode: row.error_code,
    error: row.error,
    attempts: Number(row.attempts),
    cancelRequested: Number(row.cancel_requested) === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    itemId: payload.itemId ?? null,
    sessionId: payload.sessionId ?? null,
  };
}

/**
 * Queue a job. Idempotent on `requestId`; and if the same work is already queued or
 * running for this idea, that job is returned instead of piling up a second one.
 */
export async function enqueueJob(
  ctx: AppContext,
  input: {
    ideaId: string;
    payload: JobPayload;
    requestId?: string | undefined;
    timeoutMs?: number | undefined;
  },
): Promise<JobDto> {
  if (!ctx.provider.canReason)
    throw conflict(
      `No reasoning provider is configured for the web UI (${ctx.provider.status()}). ` +
        'Reason from a VS Code agent through the CLI, or configure IDEA_SYNTH_PROVIDER.',
    );
  await requireIdea(ctx.db, input.ideaId);
  const row = await ctx.db.transaction().execute(async (trx) => {
    if (input.requestId) {
      const seen = await trx
        .selectFrom('jobs')
        .selectAll()
        .where('request_id', '=', input.requestId)
        .executeTakeFirst();
      if (seen) return seen;
    }
    const payloadJson = JSON.stringify(input.payload);
    const same = await trx
      .selectFrom('jobs')
      .selectAll()
      .where('idea_id', '=', input.ideaId)
      .where('kind', '=', input.payload.kind)
      .where('status', 'in', ACTIVE)
      .execute();
    const duplicate = same.find((j) => j.payload_json === payloadJson);
    if (duplicate) return duplicate;
    const now = nowIso();
    const id = newId('job');
    await trx
      .insertInto('jobs')
      .values({
        id,
        idea_id: input.ideaId,
        kind: input.payload.kind,
        payload_json: payloadJson,
        status: 'queued',
        progress: null,
        error_code: null,
        error: null,
        request_id: input.requestId ?? null,
        timeout_ms: input.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
        worker_id: null,
        heartbeat_at: null,
        created_at: now,
        started_at: null,
        finished_at: null,
        updated_at: now,
      })
      .execute();
    return trx.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  });
  return toJobDto(row);
}

export async function getJob(db: Db, jobId: string): Promise<JobDto> {
  const row = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirst();
  if (!row) throw notFound('Job', jobId);
  return toJobDto(row);
}

export async function listJobs(
  db: Db,
  filter: { ideaId?: string | undefined; activeOnly?: boolean | undefined; limit?: number } = {},
): Promise<JobDto[]> {
  let query = db
    .selectFrom('jobs')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(filter.limit ?? 50);
  if (filter.ideaId) query = query.where('idea_id', '=', filter.ideaId);
  if (filter.activeOnly) query = query.where('status', 'in', ACTIVE);
  return (await query.execute()).map(toJobDto);
}

/** Ask for a job to stop. A queued job stops at once; a running one is aborted by its worker. */
export async function requestCancel(db: Db, jobId: string): Promise<JobDto> {
  await db.transaction().execute(async (trx) => {
    const job = await trx.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirst();
    if (!job) throw notFound('Job', jobId);
    if (!ACTIVE.includes(job.status)) throw conflict(`This job has already ${job.status}.`);
    const now = nowIso();
    await trx
      .updateTable('jobs')
      .set(
        job.status === 'queued'
          ? {
              status: 'cancelled',
              cancel_requested: 1,
              finished_at: now,
              updated_at: now,
              error: 'Cancelled before it started.',
            }
          : { cancel_requested: 1, updated_at: now },
      )
      .where('id', '=', jobId)
      .execute();
  });
  return getJob(db, jobId);
}

function failureOf(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderError) return { code: error.code, message };
  if (error instanceof DomainError) {
    const reason = (error.details as { reason?: string } | undefined)?.reason;
    return { code: reason ?? error.code, message };
  }
  return { code: 'internal', message };
}

export interface JobRunnerOptions {
  concurrency?: number;
  pollMs?: number;
  heartbeatMs?: number;
  workerId?: string;
}

/** Runs queued jobs inside the server process. One per process. */
export class JobRunner {
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  readonly workerId: string;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly ctx: AppContext,
    options: JobRunnerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 2;
    this.pollMs = options.pollMs ?? 500;
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    this.workerId = options.workerId ?? `worker_${process.pid}_${newId('job').slice(-6)}`;
  }

  /**
   * After a restart: jobs this database still thinks are running belong to a process
   * that no longer exists. They are marked `interrupted` and, because every handler is
   * resumable, queued again (up to a bounded number of attempts).
   */
  async recover(): Promise<number> {
    const now = Date.now();
    return this.ctx.db.transaction().execute(async (trx) => {
      const running = await trx
        .selectFrom('jobs')
        .selectAll()
        .where('status', '=', 'running')
        .execute();
      let recovered = 0;
      for (const job of running) {
        const mine = this.active.has(job.id);
        const alive = job.heartbeat_at && now - Date.parse(job.heartbeat_at) < HEARTBEAT_STALE_MS;
        if (mine || (alive && job.worker_id !== this.workerId)) continue;
        const retry = Number(job.attempts) < MAX_ATTEMPTS && Number(job.cancel_requested) === 0;
        await trx
          .updateTable('jobs')
          .set({
            status: retry ? 'queued' : 'interrupted',
            worker_id: null,
            progress: retry ? 'Resuming after a restart' : job.progress,
            error_code: retry ? null : 'interrupted',
            error: retry
              ? null
              : 'The server stopped while this was running, and it has been retried too often.',
            finished_at: retry ? null : nowIso(),
            updated_at: nowIso(),
          })
          .where('id', '=', job.id)
          .execute();
        recovered++;
      }
      return recovered;
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** Stop taking work and abort what is running (it will be resumed on the next start). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const { controller } of this.active.values())
      controller.abort(new ProviderError('Server shutting down.', { code: 'cancelled' }));
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }

  /** Run until nothing is queued or running. For tests and the seed. */
  async drain(): Promise<void> {
    for (;;) {
      await this.tick();
      if (this.active.size === 0) {
        const left = await this.ctx.db
          .selectFrom('jobs')
          .select('id')
          .where('status', '=', 'queued')
          .execute();
        if (left.length === 0) return;
      }
      await Promise.race([
        ...[...this.active.values()].map((a) => a.done),
        new Promise<void>((resolve) => setTimeout(resolve, 5)),
      ]);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.recover();
      while (this.active.size < this.concurrency) {
        const job = await this.claim();
        if (!job) break;
        const controller = new AbortController();
        const done = this.run(job, controller).finally(() => this.active.delete(job.id));
        this.active.set(job.id, { controller, done });
      }
    } catch (error) {
      console.error('job runner tick failed:', error);
    } finally {
      this.ticking = false;
    }
  }

  /** Atomically take the oldest queued job whose idea has nothing running. */
  private claim(): Promise<JobRow | null> {
    return this.ctx.db.transaction().execute(async (trx) => {
      const queued = await trx
        .selectFrom('jobs')
        .selectAll()
        .where('status', '=', 'queued')
        .orderBy('id')
        .limit(20)
        .execute();
      if (queued.length === 0) return null;
      const busy = new Set(
        (
          await trx.selectFrom('jobs').select('idea_id').where('status', '=', 'running').execute()
        ).map((r) => r.idea_id),
      );
      const job = queued.find((j) => !busy.has(j.idea_id));
      if (!job) return null;
      const now = nowIso();
      await trx
        .updateTable('jobs')
        .set((eb) => ({
          status: 'running',
          worker_id: this.workerId,
          attempts: eb('attempts', '+', 1),
          started_at: job.started_at ?? now,
          heartbeat_at: now,
          updated_at: now,
          progress: 'Starting',
        }))
        .where('id', '=', job.id)
        .where('status', '=', 'queued')
        .execute();
      return { ...job, status: 'running' as const };
    });
  }

  private async run(job: JobRow, controller: AbortController): Promise<void> {
    const { db } = this.ctx;
    const set = (values: Partial<JobRow>) =>
      db
        .updateTable('jobs')
        .set({ ...values, updated_at: nowIso() })
        .where('id', '=', job.id)
        .execute();

    const timeout = setTimeout(
      () =>
        controller.abort(
          new ProviderError(`Timed out after ${Math.round(job.timeout_ms / 1000)}s.`, {
            code: 'timeout',
          }),
        ),
      job.timeout_ms,
    );
    const heartbeat = setInterval(() => {
      void (async () => {
        const row = await db
          .selectFrom('jobs')
          .select('cancel_requested')
          .where('id', '=', job.id)
          .executeTakeFirst();
        if (row && Number(row.cancel_requested) === 1)
          controller.abort(new ProviderError('Cancelled by the user.', { code: 'cancelled' }));
        await set({ heartbeat_at: nowIso() });
      })().catch(() => undefined);
    }, this.heartbeatMs);

    const options: PassOptions = {
      signal: controller.signal,
      onProgress: async (message) => void (await set({ progress: message })),
      meta: { client: 'worker', clientSession: job.id },
    };
    try {
      const payload = JSON.parse(job.payload_json) as JobPayload;
      await this.execute(job, payload, options);
      await set({
        status: 'completed',
        progress: 'Done',
        finished_at: nowIso(),
        error: null,
        error_code: null,
      });
    } catch (error) {
      const reason = controller.signal.aborted
        ? failureOf(controller.signal.reason)
        : failureOf(error);
      const status: JobStatus =
        reason.code === 'cancelled' ? 'cancelled' : reason.code === 'timeout' ? 'failed' : 'failed';
      // A server shutdown is not a verdict on the job: leave it running so recover() resumes it.
      if (reason.message === 'Server shutting down.') return;
      await set({ status, error_code: reason.code, error: reason.message, finished_at: nowIso() });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }

  /** The complete list of things a job can do. There is no generic "run this" job. */
  private async execute(job: JobRow, payload: JobPayload, options: PassOptions): Promise<void> {
    const { ctx } = this;
    switch (payload.kind) {
      case 'analyze': {
        const idea = await requireIdea(ctx.db, job.idea_id);
        if (idea.stage === 'in_review' || idea.stage === 'synthesized') return; // already done (resumed job)
        return runAnalysis(ctx, job.idea_id, options);
      }
      case 'synthesize':
        return runSynthesis(ctx, job.idea_id, { ...options, override: payload.override });
      case 'discuss_reply': {
        const last = await ctx.db
          .selectFrom('discussion_messages')
          .select('author')
          .where('item_id', '=', payload.itemId)
          .orderBy('seq', 'desc')
          .executeTakeFirst();
        if (last?.author === 'agent') return; // the reply already landed (resumed job)
        return requestAgentReply(ctx, payload.itemId, options);
      }
      case 'guided_turn':
        return advanceSession(ctx, payload.sessionId, options);
      case 'guided_handoff': {
        const idea = await requireIdea(ctx.db, job.idea_id);
        if (idea.stage !== 'guided') return;
        await handOffToSynthesis(ctx, payload.sessionId, options);
        return;
      }
    }
  }
}

export type { JobKind };
