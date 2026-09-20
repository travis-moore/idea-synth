/**
 * Regression tests for the adversarial review of the initial implementation
 * (shared-tools/prompts/adversarial-review.md). Each describes a way the first version
 * broke one of the project's own non-negotiables.
 */
import { describe, expect, it } from 'vitest';
import { MockProvider, type ModelProvider, type StructuredRequest } from '../src/ai';
import { openTestDb } from '../src/db/client';
import { locateQuote } from '../src/domain/quotes';
import {
  getGuidedSession,
  handOffToSynthesis,
  replyToTutor,
  respondToPremise,
  startGuidedSession,
} from '../src/services/guided';
import { captureIdea } from '../src/services/ideas';
import { decide, promoteTangent, supersedeItem } from '../src/services/items';
import { runAnalysis, runSynthesis } from '../src/services/pipeline';
import { getIdea, getSynthesis, listIdeaItems, listInbox, listRuns } from '../src/services/queries';
import { analysedPyramids, itemByKey, PYRAMIDS_TEXT, testContext } from './helpers';

class Tamper implements ModelProvider {
  readonly name = 'tamper';
  readonly model = 'test';
  readonly live = false;
  calls: string[] = [];
  private readonly inner = new MockProvider();
  constructor(
    private readonly key: string,
    private readonly fn: (output: never) => unknown,
    public remaining = Infinity,
  ) {}
  async generate<T>(request: StructuredRequest<T>): Promise<unknown> {
    this.calls.push(`${request.pass}:${request.task}`);
    const output = await this.inner.generate(request);
    if (`${request.pass}:${request.task}` !== this.key || this.remaining <= 0) return output;
    this.remaining--;
    return this.fn(structuredClone(output) as never);
  }
}

const clearInbox = async (db: Awaited<ReturnType<typeof testContext>>['db'], ideaId: string) => {
  for (const item of await listInbox(db, ideaId)) await decide(db, item.id, { decision: 'accept' });
};

describe('authorship', () => {
  it("never labels items extracted from an AI-written tangent as the user's words", async () => {
    const ctx = await testContext();
    const idea = await analysedPyramids(ctx);
    const tangent = await itemByKey(ctx, idea.id, 'x_games');
    const promoted = await promoteTangent(ctx.db, tangent.id);
    await runAnalysis(ctx, promoted.id);
    const items = await listIdeaItems(ctx.db, promoted.id);
    expect(items.length).toBeGreaterThan(1);
    expect(items.filter((i) => i.origin !== 'agent')).toEqual([]);
  });

  it('does not accept an "extraction" whose quote is not in the user\'s text', async () => {
    const provider = new Tamper(
      'extract:extract',
      (out: { items: Array<Record<string, unknown>> }) => {
        out.items.push({
          key: 'e_invented',
          kind: 'factual_claim',
          text: 'The user believes aliens built the pyramids.',
          source_quotes: ['aliens obviously built them'],
          links: [],
        });
        return out;
      },
    );
    const ctx = { db: await openTestDb(), provider };
    const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
    await runAnalysis(ctx, idea.id);
    const invented = await itemByKey(ctx, idea.id, 'e_invented');
    expect(invented).toMatchObject({
      origin: 'agent',
      status: 'needs_user',
      attentionReason: 'clarification_needed',
    });
    expect((await itemByKey(ctx, idea.id, 'e_hypothesis')).origin).toBe('extracted_from_user');
  });

  it('locates quotes a model has tidied, and maps them back to real offsets', () => {
    const original = 'I  think\n“pyramids”   made Egypt smart.';
    const span = locateQuote(original, 'think "pyramids" made Egypt')!;
    expect(original.slice(span.start, span.end)).toBe('think\n“pyramids”   made Egypt');
    expect(locateQuote(original, 'aliens made Egypt smart')).toBeNull();
    expect(locateQuote(original, '   ')).toBeNull();
  });

  it('refuses structural or inbound edges written by a model', async () => {
    for (const link of [
      { type: 'supersedes', direction: 'out' },
      { type: 'merged_into', direction: 'in' },
      { type: 'derived_from', direction: 'in' },
    ]) {
      const provider = new Tamper(
        'explore:explore',
        (out: { items: Array<{ links: Array<Record<string, unknown>> }> }) => {
          Object.assign(out.items[0]!.links[0]!, link);
          return out;
        },
      );
      const ctx = { db: await openTestDb(), provider };
      const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
      await expect(runAnalysis(ctx, idea.id)).rejects.toThrow(/may not create|cannot point at/);
      expect(
        (await listIdeaItems(ctx.db, idea.id)).some((i) => i.createdByPass === 'explore'),
      ).toBe(false);
    }
  });
});

describe('review gate', () => {
  it("does not let the Builder re-close the gate behind the user's back", async () => {
    const provider = new Tamper(
      'builder:builder',
      (out: { items: Array<{ needs_user: boolean }> }) => {
        out.items[0]!.needs_user = true;
        return out;
      },
    );
    const ctx = { db: await openTestDb(), provider };
    const idea = await analysedPyramids(ctx);
    await clearInbox(ctx.db, idea.id);
    await runSynthesis(ctx, idea.id);
    expect(await listInbox(ctx.db, idea.id)).toEqual([]);
  });

  it('records an override only together with the synthesis it authorised', async () => {
    const provider = new Tamper('synthesize:synthesize', () => 'not json', 1);
    const ctx = { db: await openTestDb(), provider };
    const idea = await analysedPyramids(ctx);
    await expect(runSynthesis(ctx, idea.id, { force: true })).rejects.toThrow(
      /synthesize pass failed/,
    );
    const overrides = async () =>
      (
        await ctx.db.selectFrom('events').select('type').where('idea_id', '=', idea.id).execute()
      ).filter((e) => e.type === 'gate.overridden').length;
    expect(await overrides()).toBe(0);

    // Retry: the Builder is not run a second time, and the override is now on record.
    await runSynthesis(ctx, idea.id, { force: true });
    expect(await overrides()).toBe(1);
    const runs = (await listRuns(ctx.db, idea.id)).filter(
      (r) => r.pass === 'builder' || r.pass === 'synthesize',
    );
    expect(runs.map((r) => [r.pass, r.status])).toEqual([
      ['builder', 'completed'],
      ['synthesize', 'failed'],
      ['synthesize', 'completed'],
    ]);
    expect(provider.calls.filter((c) => c === 'builder:builder')).toHaveLength(1);
  });

  it('blocks a synthesis if something started needing the user while the model was working', async () => {
    const ctx = await testContext();
    const idea = await analysedPyramids(ctx);
    await clearInbox(ctx.db, idea.id);
    const target = await itemByKey(ctx, idea.id, 'x_coordination');
    const racing: ModelProvider = {
      name: 'racing',
      model: 'test',
      live: false,
      generate: async (request) => {
        if (request.pass === 'synthesize')
          await decide(ctx.db, target.id, { decision: 'flag_needs_user' });
        return ctx.provider.generate(request);
      },
    };
    await expect(runSynthesis({ db: ctx.db, provider: racing }, idea.id)).rejects.toThrow(
      /still need your input/,
    );
    expect(await getSynthesis(ctx.db, idea.id)).toBeNull();
  });
});

describe('state machines cannot wedge', () => {
  it('does not let a synthesis record be superseded by hand, so re-synthesis always works', async () => {
    const ctx = await testContext();
    const idea = await analysedPyramids(ctx);
    await runSynthesis(ctx, idea.id, { force: true });
    const v1 = (await getSynthesis(ctx.db, idea.id))!;
    await expect(supersedeItem(ctx.db, v1.itemId, { text: 'My own wording.' })).rejects.toThrow(
      /cannot be decided on/,
    );
    // Nothing half-happened: no orphan replacement item was left behind.
    expect((await listIdeaItems(ctx.db, idea.id)).some((i) => i.text === 'My own wording.')).toBe(
      false,
    );
    await runSynthesis(ctx, idea.id, { force: true });
    expect((await getSynthesis(ctx.db, idea.id))!.version).toBe(2);
  });

  it('lets a guided session continue when its premise was handled from the item panel', async () => {
    const ctx = await testContext();
    const sessionId = await startGuidedSession(ctx, {
      hypothesis: 'Maybe robots will mean nobody has to work.',
    });
    for (let i = 0; i < 4; i++) await replyToTutor(ctx, sessionId, { body: 'no idea' });
    const premiseId = (await getGuidedSession(ctx.db, sessionId)).steps.at(-1)!.itemId!;
    await supersedeItem(ctx.db, premiseId, { text: 'Robots only need to do the boring jobs.' });

    await respondToPremise(ctx, sessionId, { stance: 'accept' });
    const session = await getGuidedSession(ctx.db, sessionId);
    expect(session.awaitingPremiseResponse).toBe(false);
    expect(session.steps.find((s) => s.stepKind === 'premise_response')).toMatchObject({
      stance: 'modify',
    });
    expect(session.steps.at(-1)).toMatchObject({ author: 'agent', stepKind: 'question', level: 1 });
  });

  it('can retry a hand-off whose analysis failed', async () => {
    const provider = new Tamper('extract:extract', () => 'garbage', 1);
    const ctx = { db: await openTestDb(), provider };
    const sessionId = await startGuidedSession(ctx, {
      hypothesis: 'Maybe robots will mean nobody has to work.',
    });
    await expect(handOffToSynthesis(ctx, sessionId)).rejects.toThrow(/extract pass failed/);
    expect((await getGuidedSession(ctx.db, sessionId)).status).toBe('active');
    const ideaId = await handOffToSynthesis(ctx, sessionId);
    expect((await getIdea(ctx.db, ideaId)).stage).toBe('in_review');
  });

  it('keeps the session id when the very first tutor move fails', async () => {
    const provider = new Tamper('tutor:move', () => 'garbage', 1);
    const ctx = { db: await openTestDb(), provider };
    const sessionId = await startGuidedSession(ctx, { hypothesis: 'Maybe.' });
    const session = await getGuidedSession(ctx.db, sessionId);
    expect(session).toMatchObject({ awaitingTutor: true, steps: [] });
  });
});
