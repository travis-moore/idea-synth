/**
 * Guided Idea Development: the tutor asks, the user reasons, and help increases only as
 * needed (see src/domain/scaffolding.ts for the level policy, which is code, not a model).
 *
 * A turn is a small state machine whose every state is visible and recoverable:
 *
 *   answer      the tutor has asked; the user may answer
 *   assessment  the user's answer is STORED (exact text) and waits to be assessed
 *   move        the answer has been assessed; the tutor's next move is owed
 *   premise     a level-5 agent-supplied premise waits for the user's accept / reject / change
 *   none        finished, or handed off to the synthesis workflow
 *
 * The user's answer is persisted before any model is asked anything. If the assessment or
 * the next move then fails, the transcript shows a pending step and the matching retry
 * (`retryAssessment` vs `continueSession`) picks up exactly there: nothing is asked of the
 * user twice, nothing is stored twice, and the session cannot advance twice.
 *
 * The assessment and the move can be produced by the configured provider, by a local
 * worker, or by the agent in a VS Code panel through the CLI. All of them commit through
 * the same validated path (`commitPass`), against the input version they read.
 */
import type { Transaction } from 'kysely';
import { tutorAssessRequest, tutorMoveRequest, type TutorTranscriptEntry } from '../ai/passes';
import type { StructuredRequest } from '../ai/provider';
import type { TutorAssessOutput, TutorMoveOutput } from '../ai/schemas';
import type { GuidedSessionDto, GuidedStepDto } from '../api-types';
import type { Database, Db, DbOrTrx, GuidedSessionsTable, GuidedStepsTable } from '../db/schema';
import { conflict, DomainError, invalid, notFound } from '../domain/errors';
import { newId } from '../domain/ids';
import {
  nextScaffoldLevel,
  type Adequacy,
  type PremiseStance,
  type ScaffoldLevel,
} from '../domain/scaffolding';
import { USER_CREATABLE_KINDS, type Author, type ItemStatus } from '../domain/vocabulary';
import type { AppContext } from './context';
import { captureIdea } from './ideas';
import { supersedeItem } from './items';
import type { OperationMeta } from './operation';
import {
  commitPass,
  executePass,
  runAnalysis,
  type Committed,
  type PassOptions,
  type Producer,
} from './pipeline';
import {
  createItem,
  createRelation,
  inTransaction,
  logEvent,
  nowIso,
  recordDecision,
  requireIdea,
  requireItem,
} from './store';

type Trx = Transaction<Database>;
export type GuidedTask = 'answer' | 'assessment' | 'move' | 'premise' | 'none';

type StepInput = Pick<GuidedStepsTable, 'author' | 'step_kind' | 'body'> &
  Partial<
    Pick<
      GuidedStepsTable,
      | 'options_json'
      | 'adequacy'
      | 'stance'
      | 'item_id'
      | 'run_id'
      | 'level'
      | 'responds_to_step_id'
    >
  >;

const PROMPT_KINDS: ReadonlyArray<GuidedStepsTable['step_kind']> = [
  'question',
  'options',
  'supplied_premise',
];

async function requireSession(db: DbOrTrx, sessionId: string): Promise<GuidedSessionsTable> {
  const session = await db
    .selectFrom('guided_sessions')
    .selectAll()
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (!session) throw notFound('Guided session', sessionId);
  return session;
}

const listSteps = (db: DbOrTrx, sessionId: string) =>
  db
    .selectFrom('guided_steps')
    .selectAll()
    .where('session_id', '=', sessionId)
    .orderBy('seq')
    .execute();

/** An answer's assessment lives on the `feedback` step that responds to it (or, in data
 *  from the first release, on the answer step itself). */
function assessmentOf(answer: GuidedStepsTable, steps: GuidedStepsTable[]) {
  if (answer.adequacy) return { adequacy: answer.adequacy, itemId: answer.item_id };
  const feedback = steps.find((s) => s.responds_to_step_id === answer.id);
  return feedback ? { adequacy: feedback.adequacy, itemId: feedback.item_id } : null;
}

/** What the session is waiting for. Derived from the transcript, so it cannot drift. */
export function pendingTask(session: GuidedSessionsTable, steps: GuidedStepsTable[]): GuidedTask {
  if (session.status !== 'active') return 'none';
  if (session.pending_premise_item_id) return 'premise';
  const last = steps.at(-1);
  if (!last) return 'move';
  const lastAnswer = [...steps].reverse().find((s) => s.step_kind === 'answer');
  if (lastAnswer && !assessmentOf(lastAnswer, steps)) return 'assessment';
  return PROMPT_KINDS.includes(last.step_kind) ? 'answer' : 'move';
}

async function addStep(trx: Trx, session: GuidedSessionsTable, step: StepInput): Promise<string> {
  const last = await trx
    .selectFrom('guided_steps')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('session_id', '=', session.id)
    .executeTakeFirst();
  const seq = (last?.seq ?? 0) + 1;
  const id = newId('step');
  await trx
    .insertInto('guided_steps')
    .values({
      id,
      session_id: session.id,
      seq,
      author: step.author,
      step_kind: step.step_kind,
      level: step.level ?? null,
      body: step.body,
      options_json: step.options_json ?? null,
      adequacy: step.adequacy ?? null,
      stance: step.stance ?? null,
      item_id: step.item_id ?? null,
      run_id: step.run_id ?? null,
      responds_to_step_id: step.responds_to_step_id ?? null,
      created_at: nowIso(),
    })
    .execute();
  await logEvent(trx, {
    ideaId: session.idea_id,
    itemId: step.item_id ?? null,
    type: 'guided.step',
    actor: step.author,
    runId: step.run_id ?? null,
    payload: { sessionId: session.id, seq, stepKind: step.step_kind, level: step.level ?? null },
  });
  return id;
}

const updateSession = (trx: Trx, id: string, set: Partial<GuidedSessionsTable>) =>
  trx
    .updateTable('guided_sessions')
    .set({ ...set, updated_at: nowIso() })
    .where('id', '=', id)
    .execute();

const transcriptOf = (steps: GuidedStepsTable[]): TutorTranscriptEntry[] =>
  steps.map((s) => ({ author: s.author, stepKind: s.step_kind, level: s.level, body: s.body }));

const rootItemId = async (db: DbOrTrx, ideaId: string) =>
  (
    await db
      .selectFrom('reasoning_items')
      .select('id')
      .where('idea_id', '=', ideaId)
      .where('kind', '=', 'original_idea')
      .executeTakeFirstOrThrow()
  ).id;

/** Count the `partial` answers already given to the current question. */
function priorPartials(steps: GuidedStepsTable[], before: GuidedStepsTable): number {
  let n = 0;
  for (const step of [...steps].reverse()) {
    if (step.seq >= before.seq) continue;
    if (step.step_kind === 'question' && step.item_id) break; // start of the current question
    if (step.step_kind !== 'answer') continue;
    if (assessmentOf(step, steps)?.adequacy !== 'partial') break;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Steps that involve no model
// ---------------------------------------------------------------------------

/** Create the idea and its session. The hypothesis is stored exactly as given. */
export async function createGuidedSession(
  db: DbOrTrx,
  input: { hypothesis: string; author?: Author | undefined },
): Promise<{ sessionId: string; ideaId: string }> {
  return inTransaction(db, async (trx) => {
    const idea = await captureIdea(trx, {
      text: input.hypothesis,
      source: 'guided',
      stage: 'guided',
      rootOrigin: input.author === 'agent' ? 'agent' : 'user',
    });
    const now = nowIso();
    const sessionId = newId('gs');
    await trx
      .insertInto('guided_sessions')
      .values({
        id: sessionId,
        idea_id: idea.id,
        status: 'active',
        level: 1,
        question_index: 0,
        current_question_item_id: null,
        pending_premise_item_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await logEvent(trx, {
      ideaId: idea.id,
      type: 'guided.started',
      actor: 'user',
      payload: { sessionId },
    });
    return { sessionId, ideaId: idea.id };
  });
}

/**
 * Store the user's answer, exactly as submitted, BEFORE anything is inferred from it.
 * Only emptiness is validated; the text itself is never trimmed or tidied.
 */
export async function recordAnswer(db: DbOrTrx, sessionId: string, body: string): Promise<string> {
  if (!body.trim()) throw invalid('Write an answer first. "I don\'t know" is a fine answer.');
  return inTransaction(db, async (trx) => {
    const session = await requireSession(trx, sessionId);
    const task = pendingTask(session, await listSteps(trx, sessionId));
    if (task === 'assessment')
      throw conflict(
        'Your previous answer is saved and still pending assessment. Retry the assessment instead of answering again.',
      );
    if (task === 'premise')
      throw conflict(
        'Respond to the premise the agent supplied first: accept, reject or change it.',
      );
    if (task === 'move')
      throw conflict('The tutor has not asked anything yet. Use "continue" to retry.');
    if (task === 'none') throw conflict('This guided session is no longer active.');
    return addStep(trx, session, {
      author: 'user',
      step_kind: 'answer',
      level: session.level,
      body,
    });
  });
}

// ---------------------------------------------------------------------------
// Assessment and move: prepare (read-only) and apply (one transaction)
// ---------------------------------------------------------------------------

export interface PreparedGuidedTask {
  sessionId: string;
  ideaId: string;
  task: 'assessment' | 'move';
  request: StructuredRequest<unknown>;
  /** The idea revision this request was built from. Must be echoed when committing. */
  inputVersion: number;
}

/** Build the request for whichever reasoning step the session is waiting for. */
export async function prepareGuidedTask(db: Db, sessionId: string): Promise<PreparedGuidedTask> {
  const session = await requireSession(db, sessionId);
  const idea = await requireIdea(db, session.idea_id); // read the version FIRST
  const steps = await listSteps(db, sessionId);
  const task = pendingTask(session, steps);
  const level = session.level as ScaffoldLevel;
  const base = { sessionId, ideaId: idea.id, inputVersion: Number(idea.revision) };

  if (task === 'assessment') {
    const answer = [...steps].reverse().find((s) => s.step_kind === 'answer')!;
    const question = [...steps]
      .reverse()
      .find(
        (s) => s.seq < answer.seq && s.author === 'agent' && PROMPT_KINDS.includes(s.step_kind),
      );
    const request = tutorAssessRequest({
      hypothesis: idea.original_text,
      question: question?.body ?? '',
      answer: answer.body,
      level: (answer.level ?? level) as ScaffoldLevel,
      transcript: transcriptOf(steps.filter((s) => s.seq < answer.seq)),
    });
    return { ...base, task, request: request as StructuredRequest<unknown> };
  }
  if (task === 'move') {
    const advance = session.current_question_item_id === null;
    const currentQuestion = advance
      ? null
      : ((await requireItem(db, session.current_question_item_id!)).text ?? null);
    const request = tutorMoveRequest({
      hypothesis: idea.original_text,
      questionIndex: session.question_index,
      level, // chosen by nextScaffoldLevel, never by the model
      advance,
      currentQuestion,
      transcript: transcriptOf(steps),
    });
    return { ...base, task, request: request as StructuredRequest<unknown> };
  }
  if (task === 'answer')
    throw conflict('Nothing to do: the tutor is waiting for the user to answer.');
  if (task === 'premise')
    throw conflict('Nothing to do: the user must respond to the supplied premise.');
  throw conflict('Nothing to do: this guided session is no longer active.');
}

async function applyAssessment(trx: Trx, sessionId: string, out: TutorAssessOutput, runId: string) {
  const session = await requireSession(trx, sessionId);
  const steps = await listSteps(trx, sessionId);
  // Re-checked inside the transaction: two assessors must not both advance the session.
  if (pendingTask(session, steps) !== 'assessment')
    throw conflict('There is no answer waiting for assessment; nothing to do.');
  const answer = [...steps].reverse().find((s) => s.step_kind === 'answer')!;
  const idea = await requireIdea(trx, session.idea_id);
  const level = (answer.level ?? session.level) as ScaffoldLevel;

  let itemId: string | null = null;
  if (
    (out.adequacy === 'advances' || out.adequacy === 'partial') &&
    session.current_question_item_id
  ) {
    // The user's own words, stored as theirs, byte for byte.
    const kind =
      out.answer_kind && USER_CREATABLE_KINDS.includes(out.answer_kind)
        ? out.answer_kind
        : 'factual_claim';
    const item = await createItem(trx, {
      idea,
      kind,
      origin: 'user',
      text: answer.body,
      verbatim: true,
      via: 'guided',
    });
    await createRelation(trx, {
      ideaId: idea.id,
      fromItemId: item.id,
      toItemId: session.current_question_item_id,
      type: 'answers',
      author: 'user',
    });
    itemId = item.id;
  }
  await addStep(trx, session, {
    author: 'agent',
    step_kind: 'feedback',
    body: out.explanation,
    adequacy: out.adequacy,
    item_id: itemId,
    responds_to_step_id: answer.id,
    run_id: runId,
  });
  const next = nextScaffoldLevel({
    level,
    adequacy: out.adequacy,
    priorPartials: priorPartials(steps, answer),
  });
  await updateSession(trx, session.id, {
    level: next.level,
    ...(next.advanceQuestion
      ? { question_index: session.question_index + 1, current_question_item_id: null }
      : {}),
  });
  return { adequacy: out.adequacy as Adequacy, nextLevel: next.level, answerItemId: itemId };
}

async function applyMove(trx: Trx, sessionId: string, out: TutorMoveOutput, runId: string) {
  const session = await requireSession(trx, sessionId);
  const steps = await listSteps(trx, sessionId);
  if (pendingTask(session, steps) !== 'move')
    throw conflict('The tutor does not owe a move right now; nothing to do.');
  const idea = await requireIdea(trx, session.idea_id);
  const level = session.level as ScaffoldLevel;
  const advance = session.current_question_item_id === null;

  if (out.done) {
    await addStep(trx, session, {
      author: 'agent',
      step_kind: 'feedback',
      body: out.question,
      run_id: runId,
    });
    await updateSession(trx, session.id, { status: 'finished' });
    return { finished: true };
  }
  let questionItemId = session.current_question_item_id;
  if (advance) {
    const question = await createItem(trx, {
      idea,
      kind: 'question',
      origin: 'agent',
      text: out.question,
      runId,
      via: 'guided',
    });
    await createRelation(trx, {
      ideaId: idea.id,
      fromItemId: question.id,
      toItemId: await rootItemId(trx, idea.id),
      type: 'questions',
      author: 'agent',
      runId,
    });
    const lastAnswerItem = [...steps]
      .reverse()
      .map((s) => (s.step_kind === 'answer' ? assessmentOf(s, steps)?.itemId : null))
      .find((id) => id);
    if (lastAnswerItem)
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: question.id,
        toItemId: lastAnswerItem,
        type: 'derived_from',
        author: 'agent',
        runId,
      });
    questionItemId = question.id;
  }
  if (out.teaching)
    await addStep(trx, session, {
      author: 'agent',
      step_kind: 'teaching',
      level,
      body: out.teaching,
      run_id: runId,
    });

  if (out.supplied_premise) {
    if (level !== 5) throw invalid('The tutor supplied an answer below scaffolding level 5.');
    const premise = await createItem(trx, {
      idea,
      kind: out.supplied_premise.kind,
      origin: 'agent',
      text: out.supplied_premise.text,
      status: 'needs_user',
      attentionReason: 'premise_needs_response',
      runId,
      via: 'guided',
    });
    await createRelation(trx, {
      ideaId: idea.id,
      fromItemId: premise.id,
      toItemId: questionItemId!,
      type: 'answers',
      author: 'agent',
      runId,
    });
    await addStep(trx, session, {
      author: 'agent',
      step_kind: 'supplied_premise',
      level,
      body: out.supplied_premise.text,
      item_id: premise.id,
      run_id: runId,
    });
    await updateSession(trx, session.id, {
      current_question_item_id: questionItemId,
      pending_premise_item_id: premise.id,
    });
    return { finished: false, premiseItemId: premise.id };
  }
  await addStep(trx, session, {
    author: 'agent',
    step_kind: out.options?.length ? 'options' : 'question',
    level,
    body: out.question,
    options_json: out.options?.length ? JSON.stringify(out.options) : null,
    item_id: advance ? questionItemId : null,
    run_id: runId,
  });
  await updateSession(trx, session.id, { current_question_item_id: questionItemId });
  return { finished: false, questionItemId };
}

/** Commit an assessment or a move produced by ANY reasoner. */
export function commitGuidedTask(
  db: Db,
  prepared: Pick<PreparedGuidedTask, 'sessionId' | 'ideaId' | 'task' | 'inputVersion'> & {
    request?: StructuredRequest<unknown> | undefined;
  },
  raw: unknown,
  producer: Producer,
  meta: OperationMeta,
): Promise<Committed<unknown>> {
  const template = (
    prepared.task === 'assessment'
      ? tutorAssessRequest({ hypothesis: '', question: '', answer: '', level: 1, transcript: [] })
      : tutorMoveRequest({
          hypothesis: '',
          questionIndex: 0,
          level: 1,
          advance: true,
          currentQuestion: null,
          transcript: [],
        })
  ) as StructuredRequest<unknown>;
  const request = prepared.request ?? {
    ...template,
    input: { note: 'input was served to an external agent', inputVersion: prepared.inputVersion },
  };
  return commitPass(
    db,
    {
      ideaId: prepared.ideaId,
      request,
      raw,
      producer,
      readVersion: prepared.inputVersion,
      checkVersion: true,
      meta,
    },
    (trx, output, runId): Promise<unknown> =>
      prepared.task === 'assessment'
        ? applyAssessment(trx, prepared.sessionId, output as TutorAssessOutput, runId)
        : applyMove(trx, prepared.sessionId, output as TutorMoveOutput, runId),
  );
}

// ---------------------------------------------------------------------------
// Provider-driven wrappers (web UI, workers, seed)
// ---------------------------------------------------------------------------

async function runTask(
  ctx: AppContext,
  sessionId: string,
  expected: 'assessment' | 'move',
  options: PassOptions,
) {
  const prepared = await prepareGuidedTask(ctx.db, sessionId);
  if (prepared.task !== expected)
    throw conflict(
      expected === 'assessment'
        ? 'There is no answer waiting for assessment; nothing to do.'
        : 'The tutor does not owe a move right now; nothing to do.',
    );
  await options.onProgress?.(
    expected === 'assessment' ? 'Assessing your answer' : 'Preparing the next question',
  );
  await executePass(
    ctx,
    prepared.ideaId,
    prepared.request,
    (trx, output, runId): Promise<unknown> =>
      expected === 'assessment'
        ? applyAssessment(trx, sessionId, output as TutorAssessOutput, runId)
        : applyMove(trx, sessionId, output as TutorMoveOutput, runId),
    { readVersion: prepared.inputVersion, signal: options.signal, meta: options.meta },
  );
}

/** Do whatever reasoning the session is waiting for (assessment, then the move it leads to). */
export async function advanceSession(
  ctx: AppContext,
  sessionId: string,
  options: PassOptions = {},
) {
  const current = async () => {
    const session = await requireSession(ctx.db, sessionId);
    return pendingTask(session, await listSteps(ctx.db, sessionId));
  };
  if ((await current()) === 'assessment') await runTask(ctx, sessionId, 'assessment', options);
  if ((await current()) === 'move') await runTask(ctx, sessionId, 'move', options);
}

export async function startGuidedSession(
  ctx: AppContext,
  input: { hypothesis: string },
): Promise<string> {
  const { sessionId } = await createGuidedSession(ctx.db, input);
  try {
    await advanceSession(ctx, sessionId);
  } catch (error) {
    // The session exists and is recoverable with "continue"; losing its id to a provider
    // hiccup would orphan it.
    if (!(error instanceof DomainError && error.code === 'upstream')) throw error;
  }
  return sessionId;
}

/** Store the answer first (committed), then assess it and produce the next move. */
export async function replyToTutor(ctx: AppContext, sessionId: string, input: { body: string }) {
  await recordAnswer(ctx.db, sessionId, input.body);
  await advanceSession(ctx, sessionId);
}

/** Retry assessing an answer that was stored but never assessed. Never re-asks the user. */
export async function retryAssessment(
  ctx: AppContext,
  sessionId: string,
  options: PassOptions = {},
) {
  await runTask(ctx, sessionId, 'assessment', options);
  await advanceSession(ctx, sessionId, options);
}

/** Retry a tutor move that failed to arrive. */
export async function continueSession(
  ctx: AppContext,
  sessionId: string,
  options: PassOptions = {},
) {
  await runTask(ctx, sessionId, 'move', options);
}

// ---------------------------------------------------------------------------
// Supplied premises and hand-off
// ---------------------------------------------------------------------------

/**
 * A supplied premise is an ordinary item, so the user may already have dealt with it from
 * the inbox or the item panel. Then there is nothing left to decide: record what happened
 * and let the session move on, rather than deadlocking on a decision that cannot be made.
 */
const HANDLED_ELSEWHERE: Partial<Record<ItemStatus, PremiseStance>> = {
  accepted: 'accept',
  qualified: 'accept',
  rejected: 'reject',
  tangent: 'reject',
  superseded: 'modify',
  split: 'modify',
  merged: 'modify',
};

const closePremise = (trx: Trx, session: GuidedSessionsTable) =>
  updateSession(trx, session.id, {
    pending_premise_item_id: null,
    current_question_item_id: null,
    question_index: session.question_index + 1,
    level: 1,
  });

async function reconcilePremise(trx: Trx, session: GuidedSessionsTable): Promise<boolean> {
  const premiseId = session.pending_premise_item_id;
  if (!premiseId) return false;
  const premise = await requireItem(trx, premiseId);
  const stance = HANDLED_ELSEWHERE[premise.status];
  if (!stance) return false;
  await addStep(trx, session, {
    author: 'user',
    step_kind: 'premise_response',
    level: 5,
    body: `(Handled outside this session: the premise is now ${premise.status}.)`,
    stance,
    item_id: premiseId,
  });
  await closePremise(trx, session);
  return true;
}

/**
 * The user's response to an agent-supplied premise. Accepting it is the user's decision
 * about the AGENT'S premise; it never becomes the user's idea. "modify" stores the user's
 * own wording as a new user-authored item that supersedes the agent's.
 */
export async function recordPremiseResponse(
  db: DbOrTrx,
  sessionId: string,
  input: { stance: PremiseStance; body?: string | undefined },
): Promise<void> {
  await inTransaction(db, async (trx) => {
    const session = await requireSession(trx, sessionId);
    const premiseId = session.pending_premise_item_id;
    if (!premiseId) throw conflict('There is no agent-supplied premise waiting for a response.');
    if (await reconcilePremise(trx, session)) return;
    const body = input.body ?? '';
    if (input.stance === 'modify' && !body.trim())
      throw invalid('Say how you would put it instead.');

    let itemId: string | null = premiseId;
    if (input.stance === 'accept' || input.stance === 'reject')
      await recordDecision(trx, {
        itemId: premiseId,
        type: input.stance,
        author: 'user',
        rationale: body.trim() || null,
      });
    else {
      const replacement = await supersedeItem(trx, premiseId, {
        text: body,
        author: 'user',
        reason: 'The user replaced the agent-supplied premise with their own wording.',
      });
      await createRelation(trx, {
        ideaId: session.idea_id,
        fromItemId: replacement.id,
        toItemId: session.current_question_item_id!,
        type: 'answers',
        author: 'user',
      });
      itemId = replacement.id;
    }
    await addStep(trx, session, {
      author: 'user',
      step_kind: 'premise_response',
      level: 5,
      body: body.trim() ? body : input.stance,
      stance: input.stance,
      item_id: itemId,
    });
    await closePremise(trx, session);
  });
}

export async function respondToPremise(
  ctx: AppContext,
  sessionId: string,
  input: { stance: PremiseStance; body?: string | undefined },
) {
  await recordPremiseResponse(ctx.db, sessionId, input);
  await advanceSession(ctx, sessionId);
}

/** Refuse to leave guided mode while an agent-supplied premise is still unanswered. */
export async function assertReadyForHandoff(
  db: Db,
  sessionId: string,
): Promise<GuidedSessionsTable> {
  const session = await requireSession(db, sessionId);
  if (session.status === 'handed_off') throw conflict('This session has already been handed off.');
  const stillPending = await db
    .transaction()
    .execute(
      async (trx) =>
        session.pending_premise_item_id !== null && !(await reconcilePremise(trx, session)),
    );
  if (stillPending) throw conflict('Respond to the premise the agent supplied before handing off.');
  return session;
}

/**
 * Hand the reasoning tree to the normal synthesis workflow (provider-driven Steps 2-5).
 * The session is marked handed off by the stage change itself, in the transaction that
 * completes the analysis, so a failed hand-off can simply be retried.
 */
export async function handOffToSynthesis(
  ctx: AppContext,
  sessionId: string,
  options: PassOptions = {},
): Promise<string> {
  const session = await assertReadyForHandoff(ctx.db, sessionId);
  await runAnalysis(ctx, session.idea_id, options);
  return session.idea_id;
}

export async function findSessionByIdea(db: DbOrTrx, ideaId: string) {
  return db
    .selectFrom('guided_sessions')
    .selectAll()
    .where('idea_id', '=', ideaId)
    .executeTakeFirst();
}

export async function getGuidedSession(db: DbOrTrx, sessionId: string): Promise<GuidedSessionDto> {
  const session = await requireSession(db, sessionId);
  const [idea, steps] = await Promise.all([
    requireIdea(db, session.idea_id),
    listSteps(db, sessionId),
  ]);
  const task = pendingTask(session, steps);
  return {
    id: session.id,
    ideaId: session.idea_id,
    hypothesis: idea.original_text,
    status: session.status,
    level: session.level,
    inputVersion: Number(idea.revision),
    pendingTask: task,
    awaitingPremiseResponse: task === 'premise',
    awaitingAssessment: task === 'assessment',
    awaitingTutor: task === 'move',
    steps: steps.map((s): GuidedStepDto => {
      const assessment = s.step_kind === 'answer' ? assessmentOf(s, steps) : null;
      return {
        id: s.id,
        seq: s.seq,
        author: s.author,
        stepKind: s.step_kind,
        level: s.level,
        body: s.body,
        options: s.options_json ? (JSON.parse(s.options_json) as string[]) : null,
        adequacy: s.step_kind === 'answer' ? (assessment?.adequacy ?? null) : s.adequacy,
        stance: s.stance,
        itemId: s.step_kind === 'answer' ? (assessment?.itemId ?? null) : s.item_id,
        respondsToStepId: s.responds_to_step_id,
        createdAt: s.created_at,
      };
    }),
  };
}
