/**
 * Guided Idea Development: the tutor asks, the user reasons, and help increases only as
 * needed (see src/domain/scaffolding.ts for the level policy).
 *
 * Two records are kept. `guided_steps` is the full transcript, with the scaffolding
 * level and author of every turn. Turns that carry reasoning content also become
 * reasoning items in the idea's graph, with their true origin:
 *   - the tutor's questions            -> `question`, origin agent
 *   - the user's substantive answers   -> origin user, in the user's exact words
 *   - a premise supplied at level 5    -> origin agent, `needs_user` until the user
 *     accepts, rejects or replaces it. Accepting it never makes it the user's idea.
 */
import type { Transaction } from 'kysely';
import { tutorAssessRequest, tutorMoveRequest, type TutorTranscriptEntry } from '../ai/passes';
import type { TutorAssessOutput, TutorMoveOutput } from '../ai/schemas';
import type { GuidedSessionDto } from '../api-types';
import type { Database, DbOrTrx, GuidedSessionsTable, GuidedStepsTable } from '../db/schema';
import { conflict, invalid, notFound } from '../domain/errors';
import { newId } from '../domain/ids';
import { nextScaffoldLevel, type PremiseStance, type ScaffoldLevel } from '../domain/scaffolding';
import { USER_CREATABLE_KINDS } from '../domain/vocabulary';
import type { AppContext } from './context';
import { captureIdea } from './ideas';
import { supersedeItem } from './items';
import { executePass, runAnalysis } from './pipeline';
import { createItem, createRelation, logEvent, nowIso, recordDecision, requireIdea } from './store';

type Trx = Transaction<Database>;
type StepInput = Omit<
  GuidedStepsTable,
  | 'id'
  | 'seq'
  | 'session_id'
  | 'created_at'
  | 'options_json'
  | 'adequacy'
  | 'stance'
  | 'item_id'
  | 'run_id'
  | 'level'
> &
  Partial<
    Pick<GuidedStepsTable, 'options_json' | 'adequacy' | 'stance' | 'item_id' | 'run_id' | 'level'>
  >;

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

async function addStep(trx: Trx, session: GuidedSessionsTable, step: StepInput): Promise<void> {
  const last = await trx
    .selectFrom('guided_steps')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('session_id', '=', session.id)
    .executeTakeFirst();
  const seq = (last?.seq ?? 0) + 1;
  await trx
    .insertInto('guided_steps')
    .values({
      id: newId('step'),
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

/** Ask the tutor for its next move, at the level the session row says, and record it. */
async function issueMove(ctx: AppContext, sessionId: string): Promise<void> {
  const session = await requireSession(ctx.db, sessionId);
  const idea = await requireIdea(ctx.db, session.idea_id);
  const steps = await listSteps(ctx.db, sessionId);
  const advance = session.current_question_item_id === null;
  const level = session.level as ScaffoldLevel;
  const currentQuestion = advance
    ? null
    : ((
        await ctx.db
          .selectFrom('reasoning_items')
          .select('text')
          .where('id', '=', session.current_question_item_id!)
          .executeTakeFirst()
      )?.text ?? null);

  await executePass(
    ctx,
    idea.id,
    tutorMoveRequest({
      hypothesis: idea.original_text,
      questionIndex: session.question_index,
      level,
      advance,
      currentQuestion,
      transcript: transcriptOf(steps),
    }),
    async (trx, out: TutorMoveOutput, runId) => {
      if (out.done) {
        await addStep(trx, session, {
          author: 'agent',
          step_kind: 'feedback',
          body: out.question,
          run_id: runId,
        });
        await updateSession(trx, session.id, { status: 'finished' });
        return;
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
        const lastAnswer = [...steps].reverse().find((s) => s.author === 'user' && s.item_id);
        if (lastAnswer?.item_id)
          await createRelation(trx, {
            ideaId: idea.id,
            fromItemId: question.id,
            toItemId: lastAnswer.item_id,
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
        return;
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
    },
  );
}

export async function startGuidedSession(
  ctx: AppContext,
  input: { hypothesis: string },
): Promise<string> {
  const sessionId = await ctx.db.transaction().execute(async (trx) => {
    const idea = await captureIdea(trx, {
      text: input.hypothesis,
      source: 'guided',
      stage: 'guided',
    });
    const now = nowIso();
    const id = newId('gs');
    await trx
      .insertInto('guided_sessions')
      .values({
        id,
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
      payload: { sessionId: id },
    });
    return id;
  });
  await issueMove(ctx, sessionId);
  return sessionId;
}

/** True when the transcript ends with the user, i.e. a tutor move failed to arrive. */
const awaitingTutor = (session: GuidedSessionsTable, steps: GuidedStepsTable[]) =>
  session.status === 'active' && (steps.length === 0 || steps[steps.length - 1]!.author === 'user');

/** Count the `partial` answers already given to the current question. */
function priorPartials(steps: GuidedStepsTable[]): number {
  let n = 0;
  for (const step of [...steps].reverse()) {
    if (step.step_kind === 'question' && step.item_id) break; // start of the current question
    if (step.step_kind !== 'answer') continue;
    if (step.adequacy !== 'partial') break;
    n++;
  }
  return n;
}

export async function replyToTutor(ctx: AppContext, sessionId: string, input: { body: string }) {
  const body = input.body.trim();
  if (!body) throw invalid('Write an answer first. "I don\'t know" is a fine answer.');
  const session = await requireSession(ctx.db, sessionId);
  if (session.status !== 'active') throw conflict('This guided session is no longer active.');
  if (session.pending_premise_item_id)
    throw conflict('Respond to the premise the agent supplied first: accept, reject or change it.');
  const steps = await listSteps(ctx.db, sessionId);
  if (awaitingTutor(session, steps) || !session.current_question_item_id)
    throw conflict('The tutor has not asked anything yet. Use "continue" to retry.');

  const idea = await requireIdea(ctx.db, session.idea_id);
  const question = [...steps]
    .reverse()
    .find((s) => s.author === 'agent' && s.step_kind !== 'teaching');
  const level = session.level as ScaffoldLevel;

  await executePass(
    ctx,
    idea.id,
    tutorAssessRequest({
      hypothesis: idea.original_text,
      question: question?.body ?? '',
      answer: body,
      level,
      transcript: transcriptOf(steps),
    }),
    async (trx, out: TutorAssessOutput, runId) => {
      let itemId: string | null = null;
      if (out.adequacy === 'advances' || out.adequacy === 'partial') {
        // The user's own words, stored as theirs.
        const kind =
          out.answer_kind && USER_CREATABLE_KINDS.includes(out.answer_kind)
            ? out.answer_kind
            : 'factual_claim';
        const item = await createItem(trx, {
          idea,
          kind,
          origin: 'user',
          text: body,
          via: 'guided',
        });
        await createRelation(trx, {
          ideaId: idea.id,
          fromItemId: item.id,
          toItemId: session.current_question_item_id!,
          type: 'answers',
          author: 'user',
        });
        itemId = item.id;
      }
      await addStep(trx, session, {
        author: 'user',
        step_kind: 'answer',
        level,
        body,
        adequacy: out.adequacy,
        item_id: itemId,
        run_id: runId,
      });
      await addStep(trx, session, {
        author: 'agent',
        step_kind: 'feedback',
        body: out.explanation,
        run_id: runId,
      });
      const next = nextScaffoldLevel({
        level,
        adequacy: out.adequacy,
        priorPartials: priorPartials(steps),
      });
      await updateSession(trx, session.id, {
        level: next.level,
        ...(next.advanceQuestion
          ? { question_index: session.question_index + 1, current_question_item_id: null }
          : {}),
      });
    },
  );
  await issueMove(ctx, sessionId);
}

export async function respondToPremise(
  ctx: AppContext,
  sessionId: string,
  input: { stance: PremiseStance; body?: string | undefined },
) {
  const session = await requireSession(ctx.db, sessionId);
  const premiseId = session.pending_premise_item_id;
  if (!premiseId) throw conflict('There is no agent-supplied premise waiting for a response.');
  const body = input.body?.trim() ?? '';
  if (input.stance === 'modify' && !body) throw invalid('Say how you would put it instead.');

  await ctx.db.transaction().execute(async (trx) => {
    let itemId: string | null = premiseId;
    if (input.stance === 'accept')
      await recordDecision(trx, {
        itemId: premiseId,
        type: 'accept',
        author: 'user',
        rationale: body || null,
      });
    else if (input.stance === 'reject')
      await recordDecision(trx, {
        itemId: premiseId,
        type: 'reject',
        author: 'user',
        rationale: body || null,
      });
    else {
      // The user's replacement is a new, user-authored item that supersedes the agent's.
      const replacement = await supersedeItem(trx, premiseId, {
        text: body,
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
      body: body || input.stance,
      stance: input.stance,
      item_id: itemId,
    });
    await updateSession(trx, session.id, {
      pending_premise_item_id: null,
      current_question_item_id: null,
      question_index: session.question_index + 1,
      level: 1,
    });
  });
  await issueMove(ctx, sessionId);
}

/** Retry a tutor move that failed to arrive. */
export async function continueSession(ctx: AppContext, sessionId: string) {
  const session = await requireSession(ctx.db, sessionId);
  if (!awaitingTutor(session, await listSteps(ctx.db, sessionId)))
    throw conflict('The tutor is waiting for you, not the other way round.');
  await issueMove(ctx, sessionId);
}

/** Hand the reasoning tree to the normal synthesis workflow (runs Steps 2-5). */
export async function handOffToSynthesis(ctx: AppContext, sessionId: string): Promise<string> {
  const session = await requireSession(ctx.db, sessionId);
  if (session.status === 'handed_off') throw conflict('This session has already been handed off.');
  if (session.pending_premise_item_id)
    throw conflict('Respond to the premise the agent supplied before handing off.');
  await ctx.db
    .transaction()
    .execute((trx) => updateSession(trx, session.id, { status: 'handed_off' }));
  await runAnalysis(ctx, session.idea_id);
  return session.idea_id;
}

export async function getGuidedSession(db: DbOrTrx, sessionId: string): Promise<GuidedSessionDto> {
  const session = await requireSession(db, sessionId);
  const [idea, steps] = await Promise.all([
    requireIdea(db, session.idea_id),
    listSteps(db, sessionId),
  ]);
  return {
    id: session.id,
    ideaId: session.idea_id,
    hypothesis: idea.original_text,
    status: session.status,
    level: session.level,
    awaitingPremiseResponse: session.pending_premise_item_id !== null,
    awaitingTutor: awaitingTutor(session, steps),
    steps: steps.map((s) => ({
      id: s.id,
      seq: s.seq,
      author: s.author,
      stepKind: s.step_kind,
      level: s.level,
      body: s.body,
      options: s.options_json ? (JSON.parse(s.options_json) as string[]) : null,
      adequacy: s.adequacy,
      stance: s.stance,
      itemId: s.item_id,
      createdAt: s.created_at,
    })),
  };
}
