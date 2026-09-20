import { beforeEach, describe, expect, it } from 'vitest';
import { nextScaffoldLevel } from '../src/domain/scaffolding';
import type { AppContext } from '../src/services/context';
import {
  getGuidedSession,
  handOffToSynthesis,
  replyToTutor,
  respondToPremise,
  startGuidedSession,
} from '../src/services/guided';
import { getIdea, listIdeaItems, listInbox } from '../src/services/queries';
import { testContext } from './helpers';

const HYPOTHESIS = 'Maybe robots will mean nobody has to work.';

describe('scaffold level policy', () => {
  it('adds help only when the user is stuck, and resets when they advance', () => {
    expect(nextScaffoldLevel({ level: 1, adequacy: 'stuck', priorPartials: 0 })).toEqual({
      level: 2,
      advanceQuestion: false,
    });
    expect(nextScaffoldLevel({ level: 3, adequacy: 'off_track', priorPartials: 0 })).toEqual({
      level: 4,
      advanceQuestion: false,
    });
    expect(nextScaffoldLevel({ level: 4, adequacy: 'advances', priorPartials: 0 })).toEqual({
      level: 1,
      advanceQuestion: true,
    });
  });
  it('gives a partial answer one more try at the same level before adding help', () => {
    expect(nextScaffoldLevel({ level: 1, adequacy: 'partial', priorPartials: 0 }).level).toBe(1);
    expect(nextScaffoldLevel({ level: 1, adequacy: 'partial', priorPartials: 1 }).level).toBe(2);
  });
  it('never goes past level 5', () => {
    expect(nextScaffoldLevel({ level: 5, adequacy: 'stuck', priorPartials: 0 }).level).toBe(5);
  });
});

describe('10. guided idea development records who supplied what', () => {
  let ctx: AppContext;
  let sessionId: string;
  beforeEach(async () => {
    ctx = await testContext();
    sessionId = await startGuidedSession(ctx, { hypothesis: HYPOTHESIS });
  });

  it("opens with an open question and keeps the hypothesis as the user's own words", async () => {
    const session = await getGuidedSession(ctx.db, sessionId);
    expect(session.hypothesis).toBe(HYPOTHESIS);
    expect(session.steps).toHaveLength(1);
    expect(session.steps[0]).toMatchObject({ author: 'agent', stepKind: 'question', level: 1 });
    const items = await listIdeaItems(ctx.db, session.ideaId);
    expect(items.map((i) => [i.kind, i.origin])).toEqual([
      ['original_idea', 'user'],
      ['question', 'agent'],
    ]);
  });

  it('escalates one level at a time while the user is stuck, without creating user items', async () => {
    for (const expected of [2, 3, 4]) {
      await replyToTutor(ctx, sessionId, { body: "I don't know" });
      expect((await getGuidedSession(ctx.db, sessionId)).level).toBe(expected);
    }
    const session = await getGuidedSession(ctx.db, sessionId);
    const kinds = session.steps.map((s) => s.stepKind);
    expect(kinds).toContain('teaching'); // level 3 taught missing background
    expect(kinds.at(-1)).toBe('options'); // level 4 offered possibilities
    expect(
      session.steps
        .filter((s) => s.stepKind === 'answer')
        .every((s) => s.adequacy === 'stuck' && s.itemId === null),
    ).toBe(true);
    const items = await listIdeaItems(ctx.db, session.ideaId);
    expect(items.filter((i) => i.origin === 'user' && i.kind !== 'original_idea')).toHaveLength(0);
  });

  it("stores a substantive answer verbatim as the user's, then returns to level 1", async () => {
    await replyToTutor(ctx, sessionId, { body: "I don't know" });
    const answer = 'No, robots cannot do every job yet because many jobs need judgement.';
    await replyToTutor(ctx, sessionId, { body: answer });

    const session = await getGuidedSession(ctx.db, sessionId);
    expect(session.level).toBe(1);
    const step = session.steps.find((s) => s.body === answer)!;
    expect(step).toMatchObject({ author: 'user', adequacy: 'advances', level: 2 });
    const item = (await listIdeaItems(ctx.db, session.ideaId)).find((i) => i.id === step.itemId)!;
    expect(item).toMatchObject({ origin: 'user', text: answer });
    // A new question was opened, by the agent.
    expect(session.steps.at(-1)).toMatchObject({ author: 'agent', stepKind: 'question', level: 1 });
  });

  it('explains why a bare answer is not enough before adding help', async () => {
    await replyToTutor(ctx, sessionId, { body: 'Robots' });
    let session = await getGuidedSession(ctx.db, sessionId);
    expect(session.level).toBe(1);
    expect(session.steps.find((s) => s.stepKind === 'feedback')!.body).toMatch(/why/i);
    await replyToTutor(ctx, sessionId, { body: 'Robots' });
    session = await getGuidedSession(ctx.db, sessionId);
    expect(session.level).toBe(2);
  });

  it("labels a level-5 premise as the agent's even after the user accepts it", async () => {
    for (let i = 0; i < 4; i++) await replyToTutor(ctx, sessionId, { body: 'no idea' });
    let session = await getGuidedSession(ctx.db, sessionId);
    expect(session.awaitingPremiseResponse).toBe(true);
    const premiseStep = session.steps.at(-1)!;
    expect(premiseStep).toMatchObject({ author: 'agent', stepKind: 'supplied_premise', level: 5 });
    expect((await listInbox(ctx.db, session.ideaId)).map((i) => i.id)).toEqual([
      premiseStep.itemId,
    ]);

    // The user must respond to the premise before anything else.
    await expect(replyToTutor(ctx, sessionId, { body: 'moving on' })).rejects.toThrow(/premise/);

    await respondToPremise(ctx, sessionId, { stance: 'accept' });
    session = await getGuidedSession(ctx.db, sessionId);
    const premise = (await listIdeaItems(ctx.db, session.ideaId)).find(
      (i) => i.id === premiseStep.itemId,
    )!;
    expect(premise).toMatchObject({ origin: 'agent', status: 'accepted' });
    expect(session.steps.find((s) => s.stepKind === 'premise_response')).toMatchObject({
      author: 'user',
      stance: 'accept',
    });
    expect(session.level).toBe(1);
    expect(session.awaitingPremiseResponse).toBe(false);
  });

  it('lets the user disagree: a modified premise becomes a new user-authored item', async () => {
    for (let i = 0; i < 4; i++) await replyToTutor(ctx, sessionId, { body: 'no idea' });
    const premiseId = (await getGuidedSession(ctx.db, sessionId)).steps.at(-1)!.itemId!;
    await respondToPremise(ctx, sessionId, {
      stance: 'modify',
      body: 'Robots only need to do the dull jobs.',
    });

    const session = await getGuidedSession(ctx.db, sessionId);
    const items = await listIdeaItems(ctx.db, session.ideaId);
    expect(items.find((i) => i.id === premiseId)).toMatchObject({
      origin: 'agent',
      status: 'superseded',
    });
    const mine = items.find((i) => i.text === 'Robots only need to do the dull jobs.')!;
    expect(mine.origin).toBe('user');
  });

  it('hands the reasoning tree to the synthesis workflow', async () => {
    await replyToTutor(ctx, sessionId, {
      body: 'Robots would have to be able to do all the jobs people do, because otherwise someone still works.',
    });
    const ideaId = await handOffToSynthesis(ctx, sessionId);
    const idea = await getIdea(ctx.db, ideaId);
    expect(idea.stage).toBe('in_review');
    const items = await listIdeaItems(ctx.db, ideaId);
    // Guided items survive next to the newly extracted ones.
    expect(items.some((i) => i.origin === 'user' && i.kind !== 'original_idea')).toBe(true);
    expect(items.some((i) => i.createdByPass === 'extract')).toBe(true);
    expect((await getGuidedSession(ctx.db, sessionId)).status).toBe('handed_off');
  });
});
