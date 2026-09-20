/**
 * The agent API as an external agent (Claude Code / Codex in a VS Code panel) uses it.
 * The "agent" here reasons with the mock's logic, but crucially it is the CALLER that
 * produces the output and submits it: no provider is configured or invoked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MockProvider, type StructuredRequest } from '../src/ai';
import { analysisRequests, tutorAssessRequest, tutorMoveRequest } from '../src/ai/passes';
import { runCommand } from '../src/agent-api/commands';
import { openTestDb } from '../src/db/client';
import type { Db } from '../src/db/schema';
import { decide } from '../src/services/items';
import {
  buildSnapshot,
  getGraph,
  getItemDetail,
  getSynthesis,
  listRuns,
} from '../src/services/queries';
import { prepareGuidedTask } from '../src/services/guided';
import { PYRAMIDS_TEXT } from './helpers';

let db: Db;
let n = 0;
const meta = (extra: object = {}) => ({
  requestId: `req-${++n}-abcdef`,
  agent: 'claude-code',
  sessionId: 'vscode-session-1',
  model: 'claude-test',
  ...extra,
});
const run = <T = Record<string, unknown>>(name: string, input: object = {}) =>
  runCommand({ db }, name, input) as Promise<T>;

/** Stand-in for the agent's own reasoning: what it would write for the pass it was handed. */
const brain = new MockProvider();
async function reason(ideaId: string, pass: keyof typeof analysisRequests) {
  const request = analysisRequests[pass](
    await buildSnapshot(db, ideaId),
  ) as StructuredRequest<unknown>;
  return brain.generate(request);
}

async function submitNext(ideaId: string, extra: object = {}) {
  const contract = await run<{
    pass: keyof typeof analysisRequests;
    inputVersion: number;
    outputSchema: object;
  }>('passes.next', { ideaId, ...extra });
  const output = await reason(ideaId, contract.pass);
  return run<{
    pass: string;
    next: string;
    inputVersion: number;
    applied: { created?: Record<string, string> };
  }>('passes.submit', {
    meta: meta((extra as { meta?: object }).meta),
    ideaId,
    pass: contract.pass,
    inputVersion: contract.inputVersion,
    output,
    ...((extra as { override?: object }).override
      ? { override: (extra as { override: object }).override }
      : {}),
  });
}

beforeEach(async () => {
  db = await openTestDb();
});

describe('VS Code agent as a first-class client', () => {
  it('captures, reasons, relays review decisions and synthesises, with no provider at all', async () => {
    const captured = await run<{ ideaId: string }>('ideas.capture', {
      meta: meta(),
      text: PYRAMIDS_TEXT,
      author: 'user',
    });
    const ideaId = captured.ideaId;

    const passes = [];
    for (let i = 0; i < 4; i++) passes.push((await submitNext(ideaId)).pass);
    expect(passes).toEqual(['extract', 'explore', 'epistemic', 'adversarial']);

    // A NEW session can resume from stored state alone.
    const context = await run<{
      idea: { stage: string };
      next: { kind: string };
      needsUser: Array<{ id: string }>;
      items: Array<{ origin: string }>;
    }>('ideas.context', { ideaId });
    expect(context.idea.stage).toBe('in_review');
    expect(context.next.kind).toBe('review');
    expect(context.needsUser).toHaveLength(6);

    // Runs record the external producer honestly.
    const runs = await listRuns(db, ideaId);
    expect(
      runs.every(
        (r) =>
          r.provider === 'claude-code' &&
          r.modelSource === 'self_reported' &&
          r.authMode === 'external_session',
      ),
    ).toBe(true);

    // The gate holds for this client too.
    await expect(run('passes.next', { ideaId })).rejects.toThrow(/still need your input/);

    // The agent cannot decide for the user...
    const first = context.needsUser[0]!.id;
    await expect(
      run('items.decide', { meta: meta(), itemId: first, decision: 'accept' }),
    ).rejects.toThrow(/Only the user can/);
    // ...but it can relay the user's decision, keeping their words.
    for (const item of context.needsUser)
      await run('items.decide', {
        meta: meta({ userInstruction: 'yeah accept that one' }),
        itemId: item.id,
        decision: 'accept',
      });
    const decided = await getItemDetail(db, first);
    expect(decided.decisions.at(-1)).toMatchObject({
      author: 'user',
      relayedBy: 'claude-code',
      userInstruction: 'yeah accept that one',
    });
    expect(decided.events.at(-1)!.operation).toMatchObject({
      client: 'cli',
      executedBy: 'agent',
      agentName: 'claude-code',
      clientSession: 'vscode-session-1',
    });

    expect((await submitNext(ideaId)).pass).toBe('builder');
    expect((await submitNext(ideaId)).pass).toBe('synthesize');
    const synthesis = (await getSynthesis(db, ideaId))!;
    expect(synthesis.version).toBe(1);
    expect(synthesis.provider).toBe('claude-code');
  });

  it('is idempotent on request id and refuses stale submissions, keeping them as history', async () => {
    const { ideaId } = await run<{ ideaId: string }>('ideas.capture', {
      meta: meta(),
      text: PYRAMIDS_TEXT,
      author: 'user',
    });
    const contract = await run<{ inputVersion: number }>('passes.next', { ideaId });
    const output = await reason(ideaId, 'extract');
    const m = meta();
    const first = await run<{ replayed: boolean; applied: { created: object } }>('passes.submit', {
      meta: m,
      ideaId,
      pass: 'extract',
      inputVersion: contract.inputVersion,
      output,
    });
    const again = await run<{ replayed: boolean; applied: { created: object } }>('passes.submit', {
      meta: m,
      ideaId,
      pass: 'extract',
      inputVersion: contract.inputVersion,
      output,
    });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.applied).toEqual(first.applied);
    expect(
      (await getGraph(db, ideaId)).nodes.filter((n) => n.createdByPass === 'extract'),
    ).toHaveLength(6);

    // Reasoning done against a version that then changed (the user stepped in) is refused.
    const explore = await run<{ inputVersion: number }>('passes.next', { ideaId });
    const exploreOutput = await reason(ideaId, 'explore');
    const someItem = (await getGraph(db, ideaId)).nodes.find((n) => n.kind === 'hypothesis')!;
    await decide(db, someItem.id, { decision: 'reject' });
    await expect(
      run('passes.submit', {
        meta: meta(),
        ideaId,
        pass: 'explore',
        inputVersion: explore.inputVersion,
        output: exploreOutput,
      }),
    ).rejects.toMatchObject({ details: { reason: 'stale_input' } });
    expect((await listRuns(db, ideaId)).map((r) => [r.pass, r.status])).toEqual([
      ['extract', 'completed'],
      ['explore', 'stale'],
    ]);
    const rejected = await db
      .selectFrom('operations')
      .selectAll()
      .where('status', '=', 'rejected')
      .execute();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ rejection_code: 'stale_input', agent_name: 'claude-code' });

    // Out-of-order and duplicate passes are refused as well.
    await expect(
      run('passes.submit', {
        meta: meta(),
        ideaId,
        pass: 'extract',
        inputVersion: (await run<{ inputVersion: number }>('passes.next', { ideaId })).inputVersion,
        output,
      }),
    ).rejects.toThrow(/not the next pass/);
  });

  it('rejects unknown and cross-idea references, and malformed output, without partial writes', async () => {
    const a = (
      await run<{ ideaId: string }>('ideas.capture', {
        meta: meta(),
        text: PYRAMIDS_TEXT,
        author: 'user',
      })
    ).ideaId;
    const b = (
      await run<{ ideaId: string }>('ideas.capture', {
        meta: meta(),
        text: `${PYRAMIDS_TEXT} (second copy)`,
        author: 'user',
      })
    ).ideaId;
    await submitNext(a);
    await submitNext(b);
    const foreign = (await getGraph(db, b)).nodes.find((n) => n.kind === 'hypothesis')!.id;

    const contract = await run<{ inputVersion: number }>('passes.next', { ideaId: a });
    const output = (await reason(a, 'explore')) as {
      items: Array<{ links: Array<{ to: string }> }>;
    };
    output.items[0]!.links[0]!.to = foreign;
    await expect(
      run('passes.submit', {
        meta: meta(),
        ideaId: a,
        pass: 'explore',
        inputVersion: contract.inputVersion,
        output,
      }),
    ).rejects.toThrow(/unknown item/);
    output.items[0]!.links[0]!.to = 'itm_NOPE';
    await expect(
      run('passes.submit', {
        meta: meta(),
        ideaId: a,
        pass: 'explore',
        inputVersion: contract.inputVersion,
        output,
      }),
    ).rejects.toThrow(/unknown item/);
    await expect(
      run('passes.submit', {
        meta: meta(),
        ideaId: a,
        pass: 'explore',
        inputVersion: contract.inputVersion,
        output: 'some prose',
      }),
    ).rejects.toThrow(/rejected/);
    expect((await getGraph(db, a)).nodes.some((n) => n.createdByPass === 'explore')).toBe(false);
    // Cross-idea structural operations are refused too.
    const mine = (await getGraph(db, a)).nodes.find((n) => n.kind === 'hypothesis')!.id;
    await expect(
      run('items.merge', {
        meta: meta({ userInstruction: 'merge them' }),
        itemIds: [mine, foreign],
        text: 'x',
        author: 'agent',
      }),
    ).rejects.toThrow(/same idea/);
  });

  it('keeps agent authorship through user-approved restructuring, and user text verbatim', async () => {
    const { ideaId } = await run<{ ideaId: string }>('ideas.capture', {
      meta: meta(),
      text: PYRAMIDS_TEXT,
      author: 'user',
    });
    await submitNext(ideaId);
    const hypothesis = (await getGraph(db, ideaId)).nodes.find((n) => n.kind === 'hypothesis')!;

    await expect(
      run('items.split', {
        meta: meta(),
        itemId: hypothesis.id,
        children: [
          { text: 'a', author: 'agent' },
          { text: 'b', author: 'agent' },
        ],
      }),
    ).rejects.toThrow(/Only the user can/);
    const split = await run<{ result: { childIds: string[] } }>('items.split', {
      meta: meta({
        userInstruction: 'ok, split it the way you suggested, but the second one in my words',
      }),
      itemId: hypothesis.id,
      children: [
        { text: 'Hard projects build technical skill.', author: 'agent' },
        { text: '  and admin capacity too i reckon ', author: 'user' },
      ],
    });
    const [agentChild, userChild] = await Promise.all(
      split.result.childIds.map((id) => getItemDetail(db, id)),
    );
    expect(agentChild!.item.origin).toBe('agent');
    expect(userChild!.item).toMatchObject({
      origin: 'user',
      text: '  and admin capacity too i reckon ',
    });

    await run('items.decide', {
      meta: meta({ userInstruction: 'accept it' }),
      itemId: agentChild!.item.id,
      decision: 'accept',
    });
    expect((await getItemDetail(db, agentChild!.item.id)).item).toMatchObject({
      origin: 'agent',
      status: 'accepted',
    });

    // The agent may reword its own item, never the user's.
    await run('items.revise', {
      meta: meta(),
      itemId: agentChild!.item.id,
      text: 'Hard projects build technical skills.',
      author: 'agent',
    });
    await expect(
      run('items.revise', {
        meta: meta(),
        itemId: userChild!.item.id,
        text: 'Tidier.',
        author: 'agent',
      }),
    ).rejects.toThrow(/may not reword/);

    // Discussion: each voice is stored as itself, the user's exactly.
    await run('items.discuss', {
      meta: meta(),
      itemId: userChild!.item.id,
      author: 'user',
      body: ' hmm, not sure about "capacity" ',
    });
    await run('items.discuss', {
      meta: meta(),
      itemId: userChild!.item.id,
      author: 'agent',
      body: 'What would count as capacity here?',
    });
    expect(
      (await getItemDetail(db, userChild!.item.id)).messages.map((m) => [m.author, m.body]),
    ).toEqual([
      ['user', ' hmm, not sure about "capacity" '],
      ['agent', 'What would count as capacity here?'],
    ]);
  });

  it("binds a relayed gate override to the reviewed items and to the user's words", async () => {
    const { ideaId } = await run<{ ideaId: string }>('ideas.capture', {
      meta: meta(),
      text: PYRAMIDS_TEXT,
      author: 'user',
    });
    for (let i = 0; i < 4; i++) await submitNext(ideaId);
    const blocking = (
      await run<{ blocking: Array<{ id: string }> }>('gate.check', { ideaId })
    ).blocking.map((b) => b.id);
    const override = { blockingItemIds: blocking };

    const contract = await run<{ inputVersion: number; pass: 'builder' }>('passes.next', {
      ideaId,
      override,
    });
    const output = await reason(ideaId, 'builder');
    await expect(
      run('passes.submit', {
        meta: meta(),
        ideaId,
        pass: 'builder',
        inputVersion: contract.inputVersion,
        output,
        override,
      }),
    ).rejects.toThrow(/Only the user can override/);
    await run('passes.submit', {
      meta: meta({ userInstruction: 'just build it, I know those six are open' }),
      ideaId,
      pass: 'builder',
      inputVersion: contract.inputVersion,
      output,
      override,
    });

    // A new blocking item appears: the old override does not cover it.
    const late = (await getGraph(db, ideaId)).nodes.find(
      (n) => n.status === 'open' && n.kind === 'implication',
    )!;
    await decide(db, late.id, { decision: 'flag_needs_user' });
    await expect(run('passes.next', { ideaId, override })).rejects.toMatchObject({
      details: { uncoveredItemIds: [late.id] },
    });
  });

  it('drives guided development with the level chosen by code and the answer stored first', async () => {
    const started = await run<{ sessionId: string; ideaId: string }>('guided.start', {
      meta: meta(),
      hypothesis: 'Maybe robots will mean nobody has to work.',
    });
    const sessionId = started.sessionId;
    const act = async () => {
      const task = await run<{ task: 'assessment' | 'move'; inputVersion: number }>('guided.next', {
        sessionId,
      });
      const prepared = await prepareGuidedTask(db, sessionId);
      const input = prepared.request.input as never;
      const request = (
        task.task === 'assessment' ? tutorAssessRequest(input) : tutorMoveRequest(input)
      ) as StructuredRequest<unknown>;
      const output = await brain.generate(request);
      return run<{ pendingTask: string; level: number }>('guided.submit', {
        meta: meta(),
        sessionId,
        task: task.task,
        inputVersion: task.inputVersion,
        output,
      });
    };
    expect((await act()).pendingTask).toBe('answer');

    await run('guided.answer', { meta: meta(), sessionId, body: "  I don't know " });
    const session = await run<{
      pendingTask: string;
      steps: Array<{ body: string; adequacy: string | null }>;
    }>('guided.get', { sessionId });
    expect(session.pendingTask).toBe('assessment');
    expect(session.steps.at(-1)).toMatchObject({ body: "  I don't know ", adequacy: null });
    await expect(run('guided.answer', { meta: meta(), sessionId, body: 'again' })).rejects.toThrow(
      /pending assessment/,
    );

    expect(await act()).toMatchObject({ pendingTask: 'move', level: 2 }); // code raised the level
    expect(await act()).toMatchObject({ pendingTask: 'answer', level: 2 });
    // A model that jumps to supplying an answer below level 5 is refused.
    await run('guided.answer', { meta: meta(), sessionId, body: 'no idea' });
    await act();
    const move = await run<{ inputVersion: number }>('guided.next', { sessionId });
    await expect(
      run('guided.submit', {
        meta: meta(),
        sessionId,
        task: 'move',
        inputVersion: move.inputVersion,
        output: {
          question: 'Here.',
          supplied_premise: { text: 'Because I say so.', kind: 'assumption' },
        },
      }),
    ).rejects.toThrow(/below scaffolding level 5/);
  });

  it('validates command input and requires agents to identify themselves', async () => {
    await expect(run('ideas.capture', { text: 'x', author: 'user' })).rejects.toThrow(/meta/);
    await expect(
      run('ideas.capture', {
        meta: { requestId: 'short', agent: 'codex' },
        text: 'x',
        author: 'user',
      }),
    ).rejects.toThrow(/requestId/);
    await expect(run('nope.nothing', {})).rejects.toThrow(/Unknown command/);
    const agentIdea = await run<{ ideaId: string }>('ideas.capture', {
      meta: meta({ agent: 'codex' }),
      text: 'An idea the agent proposed.',
      author: 'agent',
    });
    expect((await getGraph(db, agentIdea.ideaId)).nodes[0]).toMatchObject({
      kind: 'original_idea',
      origin: 'agent',
    });
  });
});
