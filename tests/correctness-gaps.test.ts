/**
 * Regression tests for three gaps found after the first release. Each was written and
 * observed failing BEFORE the fix (see the commit message for the red run).
 *
 *  A. a guided answer was only stored after the tutor's assessment succeeded, and trimmed
 *  B. a synthesis could publish conclusions from input that changed while the model ran
 *  C. operations assumed the user wrote every text the user approved
 */
import { describe, expect, it } from 'vitest';
import type { StructuredRequest } from '../src/ai';
import { openTestDb } from '../src/db/client';
import {
  continueSession,
  getGuidedSession,
  replyToTutor,
  retryAssessment,
  startGuidedSession,
} from '../src/services/guided';
import { branchItem, decide, splitItem, supersedeItem } from '../src/services/items';
import { runSynthesis } from '../src/services/pipeline';
import {
  getItemDetail,
  getSynthesis,
  listIdeaItems,
  listInbox,
  listRuns,
} from '../src/services/queries';
import { analysedPyramids, itemByKey, providerFrom, testContext, TestProvider } from './helpers';

/** Fails the given task `failures` times, then behaves like the mock. */
class Flaky extends TestProvider {
  override readonly name = 'flaky';
  calls: string[] = [];
  constructor(
    private readonly task: string,
    private failures: number,
  ) {
    super();
  }
  override async generate<T>(request: StructuredRequest<T>): Promise<unknown> {
    const key = `${request.pass}:${request.task}`;
    this.calls.push(key);
    if (key === this.task && this.failures-- > 0) throw new Error('model unavailable');
    return this.inner.generate(request);
  }
}

const HYPOTHESIS = 'Maybe robots will mean nobody has to work.';

describe('A. guided answers are preserved before any inference', () => {
  it('stores the exact text even when assessment fails, and retrying does not duplicate it', async () => {
    const provider = new Flaky('tutor:assess', 1);
    const ctx = { db: await openTestDb(), provider };
    const sessionId = await startGuidedSession(ctx, { hypothesis: HYPOTHESIS });
    const exact = '  Because robots would have to do ALL the jobs,\n  surely?  ';

    await expect(replyToTutor(ctx, sessionId, { body: exact })).rejects.toThrow(/assess/i);

    let session = await getGuidedSession(ctx.db, sessionId);
    const answers = () => session.steps.filter((s) => s.stepKind === 'answer');
    expect(answers()).toHaveLength(1);
    expect(answers()[0]!.body).toBe(exact);
    expect(answers()[0]!.adequacy).toBeNull();
    expect(session.awaitingAssessment).toBe(true);
    expect(session.awaitingTutor).toBe(false);

    // A second submission must not pile a duplicate answer on top of the pending one.
    await expect(replyToTutor(ctx, sessionId, { body: 'again' })).rejects.toThrow(/saved|pending/i);

    await retryAssessment(ctx, sessionId);
    session = await getGuidedSession(ctx.db, sessionId);
    expect(answers()).toHaveLength(1);
    expect(answers()[0]!.adequacy).toBe('advances');
    expect(session.awaitingAssessment).toBe(false);
    // The user's item carries the exact words too.
    const item = (await listIdeaItems(ctx.db, session.ideaId)).find(
      (i) => i.id === answers()[0]!.itemId,
    )!;
    expect(item).toMatchObject({ origin: 'user', text: exact });
    // Assessing twice must not advance twice.
    await expect(retryAssessment(ctx, sessionId)).rejects.toThrow(/nothing|no answer/i);
    expect(session.steps.filter((s) => s.stepKind === 'question')).toHaveLength(2);
  });

  it('distinguishes a missing tutor move from a missing assessment', async () => {
    const provider = new Flaky('tutor:move', 0);
    const ctx = { db: await openTestDb(), provider };
    const sessionId = await startGuidedSession(ctx, { hypothesis: HYPOTHESIS });
    (provider as unknown as { failures: number }).failures = 1;

    await expect(
      replyToTutor(ctx, sessionId, {
        body: 'Robots must be able to do every job because otherwise someone works.',
      }),
    ).rejects.toThrow();
    let session = await getGuidedSession(ctx.db, sessionId);
    expect(session.awaitingAssessment).toBe(false);
    expect(session.awaitingTutor).toBe(true);
    await expect(retryAssessment(ctx, sessionId)).rejects.toThrow(/nothing|no answer/i);

    await continueSession(ctx, sessionId);
    session = await getGuidedSession(ctx.db, sessionId);
    expect(session.awaitingTutor).toBe(false);
    expect(session.steps.filter((s) => s.stepKind === 'answer')).toHaveLength(1);
    expect(provider.calls.filter((c) => c === 'tutor:assess')).toHaveLength(1);
  });

  it('rejects an empty answer without storing anything', async () => {
    const ctx = await testContext();
    const sessionId = await startGuidedSession(ctx, { hypothesis: HYPOTHESIS });
    await expect(replyToTutor(ctx, sessionId, { body: '  \n ' })).rejects.toThrow(/answer/i);
    expect((await getGuidedSession(ctx.db, sessionId)).steps).toHaveLength(1);
  });
});

describe('B. stale model results never become current reasoning', () => {
  it('does not publish a hypothesis that was rejected while the synthesis was being generated', async () => {
    const ctx = await testContext();
    const idea = await analysedPyramids(ctx);
    for (const item of await listInbox(ctx.db, idea.id))
      await decide(ctx.db, item.id, { decision: 'accept' });
    const hypothesis = await itemByKey(ctx, idea.id, 'e_hypothesis');
    await decide(ctx.db, hypothesis.id, { decision: 'accept' });

    const racing = providerFrom(async (request, mock) => {
      const output = await mock.generate(request);
      // The user changes their mind while the model is still "thinking".
      if (request.pass === 'synthesize')
        await decide(ctx.db, hypothesis.id, { decision: 'reject', rationale: 'Changed my mind.' });
      return output;
    });
    await expect(runSynthesis({ db: ctx.db, provider: racing }, idea.id)).rejects.toThrow(
      /changed|stale/i,
    );

    expect(await getSynthesis(ctx.db, idea.id)).toBeNull();
    // The stale attempt is kept as history, clearly marked, not silently discarded.
    const runs = (await listRuns(ctx.db, idea.id)).filter((r) => r.pass === 'synthesize');
    expect(runs.map((r) => r.status)).toEqual(['stale']);

    // A fresh run sees the rejection.
    await runSynthesis(ctx, idea.id);
    const synthesis = (await getSynthesis(ctx.db, idea.id))!;
    expect(synthesis.body.conclusions.flatMap((c) => c.refs)).not.toContain(hypothesis.id);
  });

  it('binds a gate override to the items the user actually reviewed', async () => {
    const ctx = await testContext();
    const idea = await analysedPyramids(ctx);
    const reviewed = (await listInbox(ctx.db, idea.id)).map((i) => i.id);
    const late = await itemByKey(ctx, idea.id, 'x_coordination');
    await decide(ctx.db, late.id, { decision: 'flag_needs_user' });

    // An override given before `late` needed attention does not cover it.
    await expect(
      runSynthesis(ctx, idea.id, { override: { blockingItemIds: reviewed } }),
    ).rejects.toThrow(/not covered|need your input/i);
    expect(await getSynthesis(ctx.db, idea.id)).toBeNull();

    await runSynthesis(ctx, idea.id, { override: { blockingItemIds: [...reviewed, late.id] } });
    expect((await getSynthesis(ctx.db, idea.id))!.version).toBe(1);
  });
});

describe('C. authorship is separate from who approves or executes', () => {
  it("keeps agent-written split children as the agent's, with the split recorded as the user's decision", async () => {
    const ctx = await testContext();
    const idea = await analysedPyramids(ctx);
    const parent = await itemByKey(ctx, idea.id, 'e_hypothesis');
    const children = await splitItem(ctx.db, parent.id, {
      children: [
        { text: 'Hard projects build technical skill.', author: 'agent' },
        { text: 'and they build admin capacity, I reckon', author: 'user' },
      ],
      rationale: 'ok split it like you suggested',
    });
    expect(children.map((c) => c.origin)).toEqual(['agent', 'user']);
    const detail = await getItemDetail(ctx.db, parent.id);
    expect(detail.decisions.at(-1)).toMatchObject({ type: 'split', author: 'user' });
    // Accepting the agent's child does not make it the user's.
    await decide(ctx.db, children[0]!.id, { decision: 'accept' });
    expect((await getItemDetail(ctx.db, children[0]!.id)).item.origin).toBe('agent');
  });

  it("records agent-written branches, replacements and rewordings as the agent's", async () => {
    const ctx = await testContext();
    const idea = await analysedPyramids(ctx);
    const parent = await itemByKey(ctx, idea.id, 'e_hypothesis');
    const branch = await branchItem(ctx.db, parent.id, {
      text: 'A narrower hypothesis.',
      author: 'agent',
    });
    expect(branch.origin).toBe('agent');
    const replacement = await supersedeItem(ctx.db, branch.id, {
      text: 'Sharper still.',
      author: 'agent',
    });
    expect(replacement.origin).toBe('agent');
    const detail = await getItemDetail(ctx.db, branch.id);
    expect(detail.decisions.at(-1)).toMatchObject({ type: 'supersede', author: 'user' });
  });
});
