/**
 * The eight-stage workflow, for every kind of reasoner.
 *
 *   Steps 2-5  extract -> explore -> epistemic -> adversarial      (analysis)
 *   [review gate: the user works through the items]
 *   Steps 6-8  builder -> synthesize (+ tangent archive)           (synthesis)
 *
 * A pass has three phases, and only the middle one involves a model:
 *
 *   preparePass  read the idea at a known INPUT VERSION and build the request
 *   (reasoning)  a provider, a local worker, or the agent in a VS Code panel produces output
 *   commitPass   validate the output, then, in ONE transaction: refuse it if the idea has
 *                changed since it was read, refuse it if it is not the legal next pass,
 *                otherwise record the run and apply it
 *
 * No transaction is ever open while a model is thinking. Valid output that arrives too
 * late is kept as a `stale` run; it is history, but it never becomes current reasoning.
 */
import type { Transaction } from 'kysely';
import { ZodError, type z } from 'zod';
import { analysisRequests, type IdeaSnapshot } from '../ai/passes';
import { ProviderError, type ProviderInfo, type StructuredRequest } from '../ai/provider';
import type {
  AdversarialOutput,
  BuilderOutput,
  EpistemicOutput,
  ExploreOutput,
  ExtractOutput,
  SynthesizeOutput,
} from '../ai/schemas';
import type { Database, Db, IdeasTable } from '../db/schema';
import { conflict, DomainError, invalid, upstream } from '../domain/errors';
import { newId } from '../domain/ids';
import { ANALYSIS_PASS_ORDER, type Pass } from '../domain/vocabulary';
import {
  applyEpistemic,
  applyFlags,
  applyNewItems,
  applySynthesis,
  enforceGate,
  type GateOverride,
} from './apply';
import type { AppContext } from './context';
import { setStage } from './ideas';
import { applyOperation, StaleInputError, type OperationMeta } from './operation';
import { buildSnapshot } from './queries';
import { logEvent, nowIso, requireIdea } from './store';

type Trx = Transaction<Database>;

export type WorkflowPass = (typeof ANALYSIS_PASS_ORDER)[number] | 'builder' | 'synthesize';
export const WORKFLOW_PASSES: readonly WorkflowPass[] = [
  ...ANALYSIS_PASS_ORDER,
  'builder',
  'synthesize',
];

/** Who produced a pass output. Recorded on the run; never includes a secret. */
export type Producer = ProviderInfo;

export interface PassOptions {
  override?: GateOverride | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void | Promise<void>) | undefined;
  /** Envelope for the operations this run performs. Defaults to a system worker. */
  meta?: Partial<OperationMeta> | undefined;
}

function describeFailure(error: unknown): string {
  if (error instanceof ZodError)
    return `Output failed validation: ${error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')}`;
  return error instanceof Error ? error.message : String(error);
}

const labelOf = (request: { pass: Pass; task: string }) =>
  request.task === request.pass ? request.pass : `${request.pass} (${request.task})`;

export interface CommitArgs<T> {
  ideaId: string;
  request: Pick<StructuredRequest<T>, 'pass' | 'task' | 'promptVersion' | 'input' | 'schema'>;
  /** Unvalidated output, from whatever reasoner produced it. */
  raw: unknown;
  producer: Producer;
  /** The idea revision the request was built from. */
  readVersion: number;
  /** False only for passes that add to a thread rather than compute from state (discussion). */
  checkVersion: boolean;
  meta: OperationMeta;
  startedAt?: string;
  /**
   * Checked inside the commit transaction BEFORE the run is recorded as completed (e.g. is
   * this still the legal next pass?). Throwing refuses the output.
   */
  guard?: ((trx: Trx) => Promise<void>) | undefined;
}

export interface Committed<R> {
  result: R;
  runId: string | null;
  inputVersion: number | null;
  replayed: boolean;
}

type RunArgs = Omit<CommitArgs<unknown>, 'raw' | 'request'> & {
  request: Pick<StructuredRequest<unknown>, 'pass' | 'task' | 'promptVersion' | 'input'>;
};

function runRecord(args: RunArgs) {
  return {
    idea_id: args.ideaId,
    pass: args.request.pass,
    provider: args.producer.name,
    model: args.producer.model,
    model_source: args.producer.modelSource,
    auth_mode: args.producer.authMode,
    prompt_version: args.request.promptVersion,
    input_json: JSON.stringify({ task: args.request.task, input: args.request.input }),
    input_version: args.readVersion,
    started_at: args.startedAt ?? nowIso(),
  };
}

/** Record an attempt that changed nothing: a failure, or valid output that arrived too late. */
async function recordUnappliedRun(
  db: Db,
  args: RunArgs,
  status: 'failed' | 'stale',
  message: string,
  output: unknown,
): Promise<void> {
  const runId = newId('run');
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('analysis_runs')
      .values({
        ...runRecord(args),
        id: runId,
        status,
        output_json: output === undefined ? null : JSON.stringify(output),
        error: message,
        operation_id: null,
        finished_at: nowIso(),
      })
      .execute();
    await logEvent(trx, {
      ideaId: args.ideaId,
      type: status === 'stale' ? 'run.stale' : 'run.failed',
      actor: 'system',
      runId,
      payload: {
        pass: args.request.pass,
        task: args.request.task,
        producer: args.producer.name,
        error: message,
      },
    });
  });
}

/** Ask the provider, recording a failed run if it errors. */
async function generateOrRecord<T>(
  ctx: AppContext,
  args: RunArgs,
  request: StructuredRequest<T>,
  signal?: AbortSignal,
) {
  try {
    return await ctx.provider.generate(request, { signal });
  } catch (error) {
    const message = describeFailure(error);
    await recordUnappliedRun(
      ctx.db,
      { ...args, producer: ctx.provider.info() },
      'failed',
      message,
      undefined,
    ).catch(() => undefined);
    throw new DomainError(
      'upstream',
      `The ${labelOf(request)} pass failed and nothing was changed. ${message}`,
      error instanceof ProviderError ? { reason: error.code } : undefined,
    );
  }
}

/**
 * Who produced the output, asked AFTER the call: only then does a provider know what it can
 * honestly report (the model the CLI says it used, the login it verified).
 */
function producedBy(ctx: AppContext, meta: OperationMeta) {
  const producer = ctx.provider.info();
  return { producer, meta: { ...meta, agentName: producer.name, agentModel: producer.model } };
}

/** Provider paths report rejected output as an upstream failure (HTTP 502), not a bad request. */
function asUpstream(error: unknown): never {
  if (error instanceof DomainError && error.code === 'invalid')
    throw upstream(error.message.replace(/ output was rejected/, ' pass failed'));
  throw error;
}

/**
 * Validate `raw` and apply it atomically. Shared by every client; this is the single gate
 * through which model-produced reasoning enters the database.
 */
export async function commitPass<T, R>(
  db: Db,
  args: CommitArgs<T>,
  apply: (trx: Trx, output: T, runId: string) => Promise<R>,
): Promise<Committed<R>> {
  const { ideaId, request } = args;
  const recordUnapplied = (status: 'failed' | 'stale', message: string, output: unknown) =>
    recordUnappliedRun(db, args, status, message, output);
  const runBase = runRecord(args);

  let output: T;
  try {
    output = (request.schema as z.ZodType<T>).parse(args.raw);
  } catch (error) {
    const message = describeFailure(error);
    // The rejected output is kept on the failed run: it is what a prompt or schema fix needs.
    await recordUnapplied(
      'failed',
      message,
      args.raw === undefined ? undefined : { rejected: args.raw },
    );
    throw invalid(
      `The ${labelOf(request)} output was rejected and nothing was changed. ${message}`,
    );
  }

  try {
    const outcome = await applyOperation(
      db,
      {
        name: `pass.${request.pass}.${request.task}`,
        ideaId,
        meta: { ...args.meta, inputVersion: args.checkVersion ? args.readVersion : undefined },
      },
      async (trx) => {
        await args.guard?.(trx);
        const runId = newId('run');
        await trx
          .insertInto('analysis_runs')
          .values({
            ...runBase,
            id: runId,
            status: 'completed',
            output_json: JSON.stringify(output),
            error: null,
            operation_id: null,
            finished_at: nowIso(),
          })
          .execute();
        await logEvent(trx, {
          ideaId,
          type: 'run.completed',
          actor: 'system',
          runId,
          payload: { pass: request.pass, task: request.task, producer: args.producer.name },
        });
        return { runId, result: await apply(trx, output, runId) };
      },
    );
    return {
      result: outcome.result.result,
      runId: outcome.result.runId,
      inputVersion: outcome.inputVersion,
      replayed: outcome.replayed,
    };
  } catch (error) {
    if (error instanceof StaleInputError) {
      // Valid work, computed from a state that no longer exists. Keep it; do not publish it.
      await recordUnapplied('stale', error.message, output);
      throw error;
    }
    const message = describeFailure(error);
    await recordUnapplied('failed', message, output);
    if (error instanceof DomainError && error.code !== 'invalid') throw error;
    throw invalid(
      `The ${labelOf(request)} output was rejected and its changes were rolled back (earlier passes are kept). ${message}`,
    );
  }
}

/**
 * Provider-driven pass: ask the configured provider, then commit like anyone else.
 * Provider and validation failures surface as `upstream` (HTTP 502).
 */
export async function executePass<T, R>(
  ctx: AppContext,
  ideaId: string,
  request: StructuredRequest<T>,
  apply: (trx: Trx, output: T, runId: string) => Promise<R>,
  options: {
    readVersion: number;
    checkVersion?: boolean;
    signal?: AbortSignal | undefined;
    meta?: Partial<OperationMeta> | undefined;
  },
): Promise<R> {
  const startedAt = nowIso();
  const info = ctx.provider.info();
  const commitArgs = {
    ideaId,
    request,
    producer: info,
    readVersion: options.readVersion,
    checkVersion: options.checkVersion ?? true,
    startedAt,
    meta: {
      client: 'worker',
      executedBy: 'agent',
      agentName: info.name,
      agentModel: info.model,
      ...options.meta,
    } satisfies OperationMeta,
  };
  const raw = await generateOrRecord(ctx, commitArgs, request, options.signal);
  try {
    return (
      await commitPass(ctx.db, { ...commitArgs, ...producedBy(ctx, commitArgs.meta), raw }, apply)
    ).result;
  } catch (error) {
    asUpstream(error);
  }
}

// ---------------------------------------------------------------------------
// Which pass is legal next
// ---------------------------------------------------------------------------

async function lastCompletedRunId(db: Db | Trx, ideaId: string, pass: Pass): Promise<string> {
  const row = await db
    .selectFrom('analysis_runs')
    .select((eb) => eb.fn.max('id').as('id'))
    .where('idea_id', '=', ideaId)
    .where('pass', '=', pass)
    .where('status', '=', 'completed')
    .executeTakeFirst();
  return row?.id ?? '';
}

/** The next pass of the workflow for this idea, or null if analysis is done and synthesis is up to the user. */
export async function nextWorkflowPass(db: Db | Trx, ideaId: string): Promise<WorkflowPass> {
  const idea = await requireIdea(db, ideaId);
  if (idea.stage === 'captured' || idea.stage === 'guided') {
    for (const pass of ANALYSIS_PASS_ORDER)
      if (!(await lastCompletedRunId(db, ideaId, pass))) return pass;
    return 'builder'; // all four ran but the stage change was lost; synthesis side is next
  }
  const [builder, synthesis] = await Promise.all([
    lastCompletedRunId(db, ideaId, 'builder'),
    lastCompletedRunId(db, ideaId, 'synthesize'),
  ]);
  // Resumable: if the Builder already ran since the last synthesis, do not run it again.
  return builder > synthesis ? 'synthesize' : 'builder';
}

async function assertLegal(db: Db | Trx, ideaId: string, pass: WorkflowPass): Promise<void> {
  const expected = await nextWorkflowPass(db, ideaId);
  if (expected !== pass)
    throw conflict(`"${pass}" is not the next pass for this idea; the next one is "${expected}".`);
}

export interface PreparedPass {
  ideaId: string;
  pass: WorkflowPass;
  request: StructuredRequest<unknown>;
  /** The idea revision this request was built from. Must be echoed when committing. */
  inputVersion: number;
}

/** Build the request for the next pass. Cheap, read-only, and never calls a model. */
export async function preparePass(
  db: Db,
  ideaId: string,
  pass: WorkflowPass,
  options: { override?: GateOverride | undefined } = {},
): Promise<PreparedPass> {
  await assertLegal(db, ideaId, pass);
  // Early gate check, so a blocked gate costs no reasoning. The binding check is at commit.
  if (pass === 'builder' || pass === 'synthesize') await enforceGate(db, ideaId, options.override);
  const snapshot: IdeaSnapshot = await buildSnapshot(db, ideaId);
  const request = analysisRequests[pass](snapshot) as StructuredRequest<unknown>;
  return { ideaId, pass, request, inputVersion: snapshot.inputVersion };
}

/** Commit the output of a workflow pass, whoever produced it. */
export async function commitWorkflowPass(
  db: Db,
  prepared: Pick<PreparedPass, 'ideaId' | 'pass' | 'inputVersion'> & {
    request?: StructuredRequest<unknown> | undefined;
  },
  raw: unknown,
  producer: Producer,
  meta: OperationMeta,
  options: { override?: GateOverride | undefined } = {},
): Promise<Committed<unknown>> {
  const { ideaId, pass } = prepared;
  // The request is rebuilt only for its schema and prompt version when the caller is
  // external; the input recorded on the run is what THEY were given at `inputVersion`.
  const request =
    prepared.request ??
    (analysisRequests[pass]({
      idea: { id: ideaId, title: '', originalText: '', originalTextOrigin: 'user' },
      items: [],
      relations: [],
      inputVersion: prepared.inputVersion,
    }) as StructuredRequest<unknown>);
  const recorded = prepared.request
    ? request
    : {
        ...request,
        input: {
          note: 'input was served to an external agent',
          inputVersion: prepared.inputVersion,
        },
      };

  return commitPass(
    db,
    {
      ideaId,
      request: recorded,
      raw,
      producer,
      readVersion: prepared.inputVersion,
      checkVersion: true,
      meta,
      guard: (trx) => assertLegal(trx, ideaId, pass),
    },
    async (trx, output, runId) => {
      const idea: IdeasTable = await requireIdea(trx, ideaId);
      switch (pass) {
        case 'extract':
          return {
            created: await applyNewItems(
              trx,
              idea,
              runId,
              'extract',
              (output as ExtractOutput).items,
            ),
          };
        case 'explore':
          return {
            created: await applyNewItems(
              trx,
              idea,
              runId,
              'explore',
              (output as ExploreOutput).items,
            ),
          };
        case 'epistemic':
          return { created: await applyEpistemic(trx, idea, runId, output as EpistemicOutput) };
        case 'adversarial': {
          const out = output as AdversarialOutput;
          const created = await applyNewItems(trx, idea, runId, 'adversarial', out.items);
          await applyFlags(trx, idea.id, runId, out.flags);
          // Steps 2-5 are complete: the idea is now the user's to review.
          await setStage(trx, ideaId, idea.stage, 'in_review');
          return { created };
        }
        case 'builder':
          await enforceGate(trx, ideaId, options.override);
          return {
            created: await applyNewItems(
              trx,
              idea,
              runId,
              'builder',
              (output as BuilderOutput).items,
            ),
          };
        case 'synthesize':
          return applySynthesis(trx, idea, runId, output as SynthesizeOutput, options.override);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Provider-driven runs (web UI, workers, seed)
// ---------------------------------------------------------------------------

// A courtesy lock so one process does not start two runs for an idea. Correctness does NOT
// depend on it: every commit re-checks the input version and pass order in its transaction,
// which also covers other processes (the CLI) and other writers (the user's own decisions).
const running = new Set<string>();
async function withIdeaLock<T>(ideaId: string, fn: () => Promise<T>): Promise<T> {
  if (running.has(ideaId)) throw conflict('A reasoning run is already in progress for this idea.');
  running.add(ideaId);
  try {
    return await fn();
  } finally {
    running.delete(ideaId);
  }
}

async function runPass(ctx: AppContext, ideaId: string, pass: WorkflowPass, options: PassOptions) {
  options.signal?.throwIfAborted();
  await options.onProgress?.(`Running ${pass}`);
  const prepared = await preparePass(ctx.db, ideaId, pass, options);
  const startedAt = nowIso();
  const info = ctx.provider.info();
  const meta: OperationMeta = {
    client: 'worker',
    executedBy: 'agent',
    agentName: info.name,
    agentModel: info.model,
    ...options.meta,
  };
  const raw = await generateOrRecord(
    ctx,
    {
      ideaId,
      request: prepared.request,
      producer: info,
      readVersion: prepared.inputVersion,
      checkVersion: true,
      meta,
      startedAt,
    },
    prepared.request,
    options.signal,
  );
  try {
    const after = producedBy(ctx, meta);
    await commitWorkflowPass(ctx.db, prepared, raw, after.producer, after.meta, options);
  } catch (error) {
    asUpstream(error);
  }
}

/** Steps 2-5. Resumable: passes that already completed are not repeated. */
export async function runAnalysis(
  ctx: AppContext,
  ideaId: string,
  options: PassOptions = {},
): Promise<void> {
  await withIdeaLock(ideaId, async () => {
    const idea = await requireIdea(ctx.db, ideaId);
    if (idea.stage !== 'captured' && idea.stage !== 'guided')
      throw conflict('This idea has already been analysed. Continue with the review.');
    for (;;) {
      const pass = await nextWorkflowPass(ctx.db, ideaId);
      if (pass === 'builder' || pass === 'synthesize') break;
      await runPass(ctx, ideaId, pass, options);
    }
  });
}

/** Synthesis only makes sense once Steps 2-5 have produced something to review. */
export async function assertSynthesisStage(db: Db, ideaId: string): Promise<void> {
  const idea = await requireIdea(db, ideaId);
  if (idea.stage !== 'in_review' && idea.stage !== 'synthesized')
    throw conflict('Run the analysis (Steps 2-5) before building a synthesis.');
}

/**
 * Steps 6-8. Refuses to run while items still need the user, unless the user overrides
 * for exactly those items; the override is recorded with the synthesis it authorised.
 */
export async function runSynthesis(
  ctx: AppContext,
  ideaId: string,
  options: PassOptions = {},
): Promise<void> {
  await withIdeaLock(ideaId, async () => {
    await assertSynthesisStage(ctx.db, ideaId);
    if ((await nextWorkflowPass(ctx.db, ideaId)) === 'builder')
      await runPass(ctx, ideaId, 'builder', options);
    await runPass(ctx, ideaId, 'synthesize', options);
  });
}
