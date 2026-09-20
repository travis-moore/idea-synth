/**
 * The ten behaviours the product spec calls out, tested against the real schema
 * (in-memory SQLite with all migrations and triggers applied).
 */
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/services/context';
import { captureIdea } from '../src/services/ideas';
import {
  branchItem,
  decide,
  discuss,
  mergeItems,
  promoteTangent,
  reviseItem,
  splitItem,
  supersedeItem,
} from '../src/services/items';
import { runSynthesis } from '../src/services/pipeline';
import {
  getGraph,
  getIdea,
  getItemDetail,
  getSynthesis,
  listIdeaItems,
  listInbox,
  listOpenQuestions,
  listTangents,
} from '../src/services/queries';
import { analysedPyramids, itemByKey, overrideAll, PYRAMIDS_TEXT, testContext } from './helpers';

let ctx: AppContext;
beforeEach(async () => {
  ctx = await testContext();
});

describe('1. the original idea is preserved', () => {
  it('stores the captured text byte-for-byte, including untidy whitespace', async () => {
    const messy = '  i think   pyramids made egypt smart??\n\n(not sure tho) ';
    const idea = await captureIdea(ctx.db, { text: messy });
    expect(idea.original_text).toBe(messy);
    const root = (await listIdeaItems(ctx.db, idea.id))[0]!;
    expect(root.kind).toBe('original_idea');
    expect(root.origin).toBe('user');
    expect(root.text).toBe(messy);
  });

  it('survives a correction being accepted', async () => {
    const idea = await analysedPyramids(ctx);
    const correction = await itemByKey(ctx, idea.id, 'c_coevolution');
    await decide(ctx.db, correction.id, { decision: 'accept' });
    const claim = await itemByKey(ctx, idea.id, 'e_caused');
    await decide(ctx.db, claim.id, {
      decision: 'reject',
      rationale: 'The correction convinced me.',
    });

    expect((await getIdea(ctx.db, idea.id)).originalText).toBe(PYRAMIDS_TEXT);
    // The corrected claim still exists, in its original wording, next to its correction.
    const after = await itemByKey(ctx, idea.id, 'e_caused');
    expect(after.text).toBe(claim.text);
    expect(after.status).toBe('rejected');
  });

  it('cannot be changed even by going straight to the database', async () => {
    const idea = await captureIdea(ctx.db, { text: 'Original thought.' });
    await expect(
      ctx.db
        .updateTable('ideas')
        .set({ original_text: 'Tidied up.' })
        .where('id', '=', idea.id)
        .execute(),
    ).rejects.toThrow(/immutable/);
    const root = (await listIdeaItems(ctx.db, idea.id))[0]!;
    await expect(reviseItem(ctx.db, root.id, { text: 'Tidied up.' })).rejects.toThrow(
      /cannot be reworded/,
    );
    await expect(
      ctx.db.updateTable('reasoning_items').set({ text: 'x' }).where('id', '=', root.id).execute(),
    ).rejects.toThrow(/immutable/);
  });
});

describe('2. AI-generated items are labelled as AI-originated', () => {
  it('gives every item from an agent pass a non-user origin', async () => {
    const idea = await analysedPyramids(ctx);
    const items = await listIdeaItems(ctx.db, idea.id);
    const fromPasses = items.filter((i) => i.createdByPass !== null);
    expect(fromPasses.length).toBeGreaterThan(10);
    for (const item of fromPasses) {
      expect(item.origin).not.toBe('user');
      expect(item.origin).toBe(item.createdByPass === 'extract' ? 'extracted_from_user' : 'agent');
    }
  });

  it('links extracted items to the passages they came from', async () => {
    const idea = await analysedPyramids(ctx);
    const claim = await itemByKey(ctx, idea.id, 'e_utility');
    const { sources } = await getItemDetail(ctx.db, claim.id);
    expect(sources).toHaveLength(1);
    const span = sources[0]!;
    expect(PYRAMIDS_TEXT.slice(span.startOffset!, span.endOffset!)).toBe(span.quote);
  });

  it('does not let acceptance or the database turn an agent idea into a user idea', async () => {
    const idea = await analysedPyramids(ctx);
    const extension = await itemByKey(ctx, idea.id, 'x_spillovers');
    await decide(ctx.db, extension.id, { decision: 'accept' });
    expect((await itemByKey(ctx, idea.id, 'x_spillovers')).origin).toBe('agent');
    await expect(
      ctx.db
        .updateTable('reasoning_items')
        .set({ origin: 'user' })
        .where('id', '=', extension.id)
        .execute(),
    ).rejects.toThrow(/immutable/);
  });
});

describe('3. false premise, productive idea', () => {
  it('keeps the surviving question alive when its parent claim is rejected', async () => {
    const idea = await analysedPyramids(ctx);
    const premise = await itemByKey(ctx, idea.id, 'e_caused');
    const survivor = await itemByKey(ctx, idea.id, 'x_survivor');
    expect(premise.epistemicVerdict).toBe('probably_false');

    await decide(ctx.db, premise.id, {
      decision: 'reject',
      rationale: 'Causation probably ran the other way.',
    });

    const after = await itemByKey(ctx, idea.id, 'e_caused');
    expect(after.status).toBe('rejected');
    expect(after.productiveDescendantIds).toContain(survivor.id);
    // Rejection does not cascade.
    expect((await itemByKey(ctx, idea.id, 'x_survivor')).status).toBe('open');
  });

  it('does not count the correction of a premise as an idea it produced', async () => {
    const idea = await analysedPyramids(ctx);
    const premise = await itemByKey(ctx, idea.id, 'e_caused');
    const correction = await itemByKey(ctx, idea.id, 'c_coevolution');
    expect(premise.productiveDescendantIds).not.toContain(correction.id);
  });
});

describe('4. splitting keeps genealogy', () => {
  it('creates children linked to a parent that is kept, marked split', async () => {
    const idea = await analysedPyramids(ctx);
    const parent = await itemByKey(ctx, idea.id, 'e_hypothesis');
    const children = await splitItem(ctx.db, parent.id, {
      children: [
        { text: 'Hard projects build technical skill.' },
        { text: 'Hard projects build administrative capacity.' },
        { text: 'These gains outlast the project.', kind: 'assumption' },
      ],
      rationale: 'These are three separate claims.',
    });
    expect(children).toHaveLength(3);

    const detail = await getItemDetail(ctx.db, parent.id);
    expect(detail.item.status).toBe('split');
    expect(detail.item.text).toBe(parent.text);
    const childLinks = detail.links.filter(
      (l) => l.direction === 'in' && l.relation.type === 'derived_from',
    );
    expect(childLinks.map((l) => l.item.id)).toEqual(
      expect.arrayContaining(children.map((c) => c.id)),
    );
    expect(detail.decisions.at(-1)).toMatchObject({
      type: 'split',
      relatedItemIds: children.map((c) => c.id),
    });
    for (const child of children) expect(child.origin).toBe('user');

    // A split parent is finished with: decide on the children instead.
    await expect(decide(ctx.db, parent.id, { decision: 'accept' })).rejects.toThrow(
      /already split/,
    );
  });

  it('supports merge and supersede without erasing the originals', async () => {
    const idea = await analysedPyramids(ctx);
    const a = await itemByKey(ctx, idea.id, 'a_selection');
    const b = await itemByKey(ctx, idea.id, 'a_common_cause');
    const merged = await mergeItems(ctx.db, {
      itemIds: [a.id, b.id],
      text: 'The pattern may be spurious.',
      kind: 'objection',
    });
    expect((await itemByKey(ctx, idea.id, 'a_selection')).status).toBe('merged');

    const replacement = await supersedeItem(ctx.db, merged.id, {
      text: 'Sharper version.',
      causedByItemId: a.id,
    });
    const graph = await getGraph(ctx.db, idea.id);
    expect(graph.nodes.find((n) => n.id === merged.id)?.status).toBe('superseded');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        fromItemId: replacement.id,
        toItemId: merged.id,
        type: 'supersedes',
      }),
    );
  });

  it('refuses edges that would make an item its own ancestor', async () => {
    const idea = await analysedPyramids(ctx);
    const parent = await itemByKey(ctx, idea.id, 'e_hypothesis');
    const child = await branchItem(ctx.db, parent.id, { text: 'A narrower hypothesis.' });
    const { createRelation } = await import('../src/services/store');
    await expect(
      createRelation(ctx.db, {
        ideaId: idea.id,
        fromItemId: parent.id,
        toItemId: child.id,
        type: 'derived_from',
        author: 'user',
      }),
    ).rejects.toThrow(/own ancestor/);
  });
});

describe('5. rejection does not erase discussion history', () => {
  it('keeps every message, decision and event after reject and reopen', async () => {
    const idea = await analysedPyramids(ctx);
    const objection = await itemByKey(ctx, idea.id, 'a_selection');
    await discuss(ctx, objection.id, {
      body: 'I only know the famous cases, so fair.',
      askAgent: true,
    });
    await discuss(ctx, objection.id, { body: 'But I still think the effect is real.' });
    await decide(ctx.db, objection.id, {
      decision: 'reject',
      rationale: 'Not convinced it matters.',
    });
    await decide(ctx.db, objection.id, { decision: 'reopen' });

    const detail = await getItemDetail(ctx.db, objection.id);
    expect(detail.messages).toHaveLength(3);
    expect(detail.decisions.map((d) => d.type)).toEqual(['reject', 'reopen']);
    expect(detail.decisions[0]).toMatchObject({ fromStatus: 'needs_user', toStatus: 'rejected' });
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['item.created', 'message.posted', 'item.decided']),
    );
  });

  it('makes history append-only at the database level', async () => {
    const idea = await analysedPyramids(ctx);
    const objection = await itemByKey(ctx, idea.id, 'a_selection');
    await discuss(ctx, objection.id, { body: 'A message.' });
    for (const table of [
      'discussion_messages',
      'decisions',
      'events',
      'item_revisions',
      'relations',
    ] as const) {
      await expect(sql`delete from ${sql.table(table)}`.execute(ctx.db)).rejects.toThrow(
        /append-only/,
      );
    }
    await expect(
      ctx.db.updateTable('discussion_messages').set({ body: 'rewritten' }).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(sql`delete from reasoning_items`.execute(ctx.db)).rejects.toThrow(
      /cannot be deleted/,
    );
  });
});

describe('6. tangent promotion', () => {
  it('creates a new explorable idea that remembers where it came from', async () => {
    const idea = await analysedPyramids(ctx);
    const tangent = await itemByKey(ctx, idea.id, 'x_games');
    expect(tangent.status).toBe('tangent');

    const promoted = await promoteTangent(ctx.db, tangent.id);
    const dto = await getIdea(ctx.db, promoted.id);
    expect(dto.source).toBe('promoted_tangent');
    expect(dto.stage).toBe('captured');
    expect(dto.promotedFrom).toMatchObject({ ideaId: idea.id, itemId: tangent.id });
    expect(dto.originalText).toBe(tangent.text);

    // The tangent stays in the original idea, now pointing at what it became.
    const after = await itemByKey(ctx, idea.id, 'x_games');
    expect(after.status).toBe('tangent');
    expect(after.promotedIdeaId).toBe(promoted.id);
    await expect(promoteTangent(ctx.db, tangent.id)).rejects.toThrow(/already been promoted/);
  });

  it('keeps AI authorship on the new idea unless the user reframes it', async () => {
    const idea = await analysedPyramids(ctx);
    const tangent = await itemByKey(ctx, idea.id, 'x_games');
    const promoted = await promoteTangent(ctx.db, tangent.id);
    expect((await listIdeaItems(ctx.db, promoted.id))[0]!.origin).toBe('agent');

    const mine = await branchItem(ctx.db, tangent.id, {
      text: 'Do sports do the same job?',
      asTangent: true,
    });
    const reframed = await promoteTangent(ctx.db, mine.id, {
      framing: 'I wonder whether sport is ritualised war.',
    });
    const root = (await listIdeaItems(ctx.db, reframed.id))[0]!;
    expect(root.origin).toBe('user');
    expect(root.text).toBe('I wonder whether sport is ritualised war.');
  });
});

describe('7. synthesis points back to its sources', () => {
  it('blocks at the review gate, then builds a traceable synthesis', async () => {
    const idea = await analysedPyramids(ctx);
    await expect(runSynthesis(ctx, idea.id)).rejects.toThrow(/still need your input/);

    for (const item of await listInbox(ctx.db, idea.id)) {
      if (item.kind === 'correction') await decide(ctx.db, item.id, { decision: 'accept' });
      else
        await decide(ctx.db, item.id, {
          decision: 'qualify',
          qualification: 'Fair, within limits.',
        });
    }
    const hypothesis = await itemByKey(ctx, idea.id, 'e_hypothesis');
    await decide(ctx.db, hypothesis.id, {
      decision: 'qualify',
      qualification: 'Only where skills transfer.',
    });
    await decide(ctx.db, (await itemByKey(ctx, idea.id, 'e_caused')).id, { decision: 'reject' });

    await runSynthesis(ctx, idea.id);
    const synthesis = (await getSynthesis(ctx.db, idea.id))!;
    expect(synthesis.version).toBe(1);
    expect(synthesis.body.conclusions.length).toBeGreaterThan(0);

    const graph = await getGraph(ctx.db, idea.id);
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const conclusion of synthesis.body.conclusions) {
      expect(conclusion.refs.length).toBeGreaterThan(0);
      for (const ref of conclusion.refs) {
        expect(ids.has(ref)).toBe(true);
        expect(graph.edges).toContainEqual(
          expect.objectContaining({
            fromItemId: ref,
            toItemId: conclusion.itemId,
            type: 'synthesized_into',
          }),
        );
      }
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          fromItemId: conclusion.itemId,
          toItemId: synthesis.itemId,
          type: 'synthesized_into',
        }),
      );
    }
    // The rejected premise is reported as rejected, with the ideas that survived it.
    expect(synthesis.body.rejected.some((r) => r.text.includes('productive mistake'))).toBe(true);
    expect(synthesis.body.initialThought.refs).toEqual([
      (await getIdea(ctx.db, idea.id)).rootItemId,
    ]);
    expect((await getIdea(ctx.db, idea.id)).stage).toBe('synthesized');
  });

  it('keeps earlier syntheses as superseded versions', async () => {
    const idea = await analysedPyramids(ctx);
    await runSynthesis(ctx, idea.id, await overrideAll(ctx, idea.id));
    await decide(ctx.db, (await itemByKey(ctx, idea.id, 'e_hypothesis')).id, {
      decision: 'accept',
    });
    await runSynthesis(ctx, idea.id, await overrideAll(ctx, idea.id));

    const [v1, v2] = [
      await getSynthesis(ctx.db, idea.id, 1),
      await getSynthesis(ctx.db, idea.id, 2),
    ];
    expect(v1 && v2).toBeTruthy();
    const graph = await getGraph(ctx.db, idea.id);
    expect(graph.nodes.find((n) => n.id === v1!.itemId)?.status).toBe('superseded');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ fromItemId: v2!.itemId, toItemId: v1!.itemId, type: 'supersedes' }),
    );
    // Forcing past the gate is itself on the record.
    const events = await ctx.db
      .selectFrom('events')
      .select(['type', 'payload_json'])
      .where('idea_id', '=', idea.id)
      .where('type', '=', 'gate.overridden')
      .execute();
    // Once per pass that ran past the gate: Builder and Synthesis, for each of the two runs.
    expect(events.map((e) => (JSON.parse(e.payload_json) as { pass: string }).pass)).toEqual([
      'builder',
      'synthesize',
      'builder',
      'synthesize',
    ]);
  });
});

describe('8. inbox, open questions and tangent views', () => {
  it('puts items in the right views and moves them as decisions are made', async () => {
    const idea = await analysedPyramids(ctx);
    const inbox = await listInbox(ctx.db, idea.id);
    expect(inbox.map((i) => i.attentionReason).sort()).toEqual([
      'ambiguous_interpretation',
      'disputed_correction',
      'unresolved_assumption',
      'unresolved_objection',
      'unresolved_objection',
      'value_judgment_input',
    ]);
    const open = await listOpenQuestions(ctx.db, idea.id);
    expect(open.length).toBeGreaterThan(inbox.length);
    expect(open.every((i) => i.status === 'open' || i.status === 'needs_user')).toBe(true);
    expect(open.some((i) => i.kind === 'original_idea')).toBe(false);
    expect((await listTangents(ctx.db, idea.id)).map((t) => t.text)).toEqual([
      expect.stringContaining('simulated conflict'),
    ]);

    const first = inbox[0]!;
    await decide(ctx.db, first.id, { decision: 'accept' });
    expect((await listInbox(ctx.db, idea.id)).map((i) => i.id)).not.toContain(first.id);
    expect((await listOpenQuestions(ctx.db, idea.id)).map((i) => i.id)).not.toContain(first.id);

    const gate = (await getIdea(ctx.db, idea.id)).gate;
    expect(gate.canProceed).toBe(false);
    expect(gate.blockingItemIds).toHaveLength(inbox.length - 1);
  });
});

describe('9. discussion history is ordered and attributable', () => {
  it('numbers messages per item and records who said what', async () => {
    const idea = await analysedPyramids(ctx);
    const a = await itemByKey(ctx, idea.id, 'a_selection');
    const b = await itemByKey(ctx, idea.id, 'a_common_cause');
    await discuss(ctx, a.id, { body: 'first', askAgent: true });
    await discuss(ctx, b.id, { body: 'other thread' });
    await discuss(ctx, a.id, { body: 'second', askAgent: true });

    const thread = (await getItemDetail(ctx.db, a.id)).messages;
    expect(thread.map((m) => [m.seq, m.author])).toEqual([
      [1, 'user'],
      [2, 'agent'],
      [3, 'user'],
      [4, 'agent'],
    ]);
    expect(thread[0]!.body).toBe('first');
    expect((await getItemDetail(ctx.db, b.id)).messages).toHaveLength(1);
  });
});

describe("agents cannot make the user's decisions", () => {
  it('only lets the agent flag items or set them aside', async () => {
    const idea = await analysedPyramids(ctx);
    const item = await itemByKey(ctx, idea.id, 'x_coordination');
    const { recordDecision } = await import('../src/services/store');
    await expect(
      recordDecision(ctx.db, { itemId: item.id, type: 'accept', author: 'agent' }),
    ).rejects.toThrow(/belongs to the user/);
    await expect(
      recordDecision(ctx.db, { itemId: item.id, type: 'reject', author: 'agent' }),
    ).rejects.toThrow();
  });

  it('records revisions with their cause instead of overwriting', async () => {
    const idea = await analysedPyramids(ctx);
    const hypothesis = await itemByKey(ctx, idea.id, 'e_hypothesis');
    const objection = await itemByKey(ctx, idea.id, 'a_selection');
    await reviseItem(ctx.db, hypothesis.id, {
      text: 'Hard collective projects sometimes develop useful capabilities.',
      reason: 'Softened after the selection-effect objection.',
      causedByItemId: objection.id,
    });
    const { revisions, item } = await getItemDetail(ctx.db, hypothesis.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]!.text).toBe(hypothesis.text);
    expect(revisions[1]).toMatchObject({ author: 'user', causedByItemId: objection.id });
    expect(item.text).toBe(revisions[1]!.text);
    expect(item.origin).toBe('extracted_from_user');
  });
});
