/**
 * What the user can do to a reasoning item at the review gate. Every operation is
 * additive: parents are never erased, authorship never changes, and each step leaves a
 * decision row plus audit events behind.
 */
import { discussRequest } from '../ai/passes';
import type { DiscussOutput } from '../ai/schemas';
import type { DbOrTrx, IdeasTable, ReasoningItemsTable } from '../db/schema';
import { conflict, invalid } from '../domain/errors';
import { USER_CREATABLE_KINDS, type DecisionType, type ItemKind } from '../domain/vocabulary';
import type { AppContext } from './context';
import { captureIdea } from './ideas';
import { executePass } from './pipeline';
import { buildSnapshot } from './queries';
import {
  addRevision,
  createItem,
  createRelation,
  inTransaction,
  logEvent,
  nowIso,
  postMessage,
  recordDecision,
  requireIdea,
  requireItem,
} from './store';

const USER_DECISIONS: readonly DecisionType[] = [
  'accept',
  'qualify',
  'reject',
  'reopen',
  'mark_tangent',
  'flag_needs_user',
];

function userKind(kind: ItemKind | undefined, fallback: ItemKind): ItemKind {
  const chosen = kind ?? (USER_CREATABLE_KINDS.includes(fallback) ? fallback : 'hypothesis');
  if (!USER_CREATABLE_KINDS.includes(chosen))
    throw invalid(`You cannot create a "${chosen}" item by hand.`);
  return chosen;
}

export interface DecideInput {
  decision: DecisionType;
  rationale?: string | undefined;
  qualification?: string | undefined;
}

/** Accept, qualify, reject, reopen, or set aside as a tangent. The discussion stays. */
export async function decide(db: DbOrTrx, itemId: string, input: DecideInput) {
  if (!USER_DECISIONS.includes(input.decision))
    throw invalid(`Use the dedicated operation for "${input.decision}".`);
  return inTransaction(db, (trx) =>
    recordDecision(trx, {
      itemId,
      type: input.decision,
      author: 'user',
      rationale: input.rationale,
      qualification: input.decision === 'qualify' ? input.qualification : null,
    }),
  );
}

export interface ChildInput {
  text: string;
  kind?: ItemKind | undefined;
}

/** Split one item into several. The parent stays, marked `split`, with its children linked. */
export async function splitItem(
  db: DbOrTrx,
  itemId: string,
  input: { children: ChildInput[]; rationale?: string | undefined },
): Promise<ReasoningItemsTable[]> {
  if (input.children.length < 2) throw invalid('Splitting needs at least two parts.');
  return inTransaction(db, async (trx) => {
    const parent = await requireItem(trx, itemId);
    const idea = await requireIdea(trx, parent.idea_id);
    const children: ReasoningItemsTable[] = [];
    for (const child of input.children) {
      const row = await createItem(trx, {
        idea,
        kind: userKind(child.kind, parent.kind),
        origin: 'user',
        text: child.text,
        via: 'split',
      });
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: row.id,
        toItemId: parent.id,
        type: 'derived_from',
        author: 'user',
        note: 'split',
      });
      children.push(row);
    }
    const childIds = children.map((c) => c.id);
    await recordDecision(trx, {
      itemId: parent.id,
      type: 'split',
      author: 'user',
      rationale: input.rationale,
      relatedItemIds: childIds,
    });
    await logEvent(trx, {
      ideaId: idea.id,
      itemId: parent.id,
      type: 'item.split',
      actor: 'user',
      payload: { childIds },
    });
    return children;
  });
}

/**
 * Grow a new item out of an existing one without retiring the parent: a new hypothesis,
 * a correction, a question needing research, or (with `asTangent`) a tangent.
 */
export async function branchItem(
  db: DbOrTrx,
  itemId: string,
  input: { text: string; kind?: ItemKind | undefined; asTangent?: boolean | undefined },
): Promise<ReasoningItemsTable> {
  return inTransaction(db, async (trx) => {
    const parent = await requireItem(trx, itemId);
    const idea = await requireIdea(trx, parent.idea_id);
    const child = await createItem(trx, {
      idea,
      kind: userKind(input.kind, input.asTangent ? 'question' : 'hypothesis'),
      origin: 'user',
      text: input.text,
      via: input.asTangent ? 'tangent' : 'branch',
    });
    if (input.asTangent) {
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: child.id,
        toItemId: parent.id,
        type: 'tangent_of',
        author: 'user',
      });
      await recordDecision(trx, {
        itemId: child.id,
        type: 'mark_tangent',
        author: 'user',
        rationale: 'Created as a tangent.',
      });
    } else {
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: parent.id,
        toItemId: child.id,
        type: 'branches_to',
        author: 'user',
      });
    }
    await logEvent(trx, {
      ideaId: idea.id,
      itemId: parent.id,
      type: 'item.branched',
      actor: 'user',
      payload: { childId: child.id, asTangent: Boolean(input.asTangent) },
    });
    return child;
  });
}

/** Merge several items into a new one. The originals stay, marked `merged`. */
export async function mergeItems(
  db: DbOrTrx,
  input: {
    itemIds: string[];
    text: string;
    kind?: ItemKind | undefined;
    rationale?: string | undefined;
  },
): Promise<ReasoningItemsTable> {
  const ids = [...new Set(input.itemIds)];
  if (ids.length < 2) throw invalid('Merging needs at least two different items.');
  return inTransaction(db, async (trx) => {
    const sources = await Promise.all(ids.map((id) => requireItem(trx, id)));
    const first = sources[0]!;
    if (sources.some((s) => s.idea_id !== first.idea_id))
      throw invalid('Only items of the same idea can be merged.');
    const idea = await requireIdea(trx, first.idea_id);
    const merged = await createItem(trx, {
      idea,
      kind: userKind(input.kind, first.kind),
      origin: 'user',
      text: input.text,
      via: 'merge',
    });
    for (const source of sources) {
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: source.id,
        toItemId: merged.id,
        type: 'merged_into',
        author: 'user',
      });
      await recordDecision(trx, {
        itemId: source.id,
        type: 'merge',
        author: 'user',
        rationale: input.rationale,
        relatedItemIds: [merged.id],
      });
    }
    await logEvent(trx, {
      ideaId: idea.id,
      itemId: merged.id,
      type: 'item.merged',
      actor: 'user',
      payload: { sourceIds: ids },
    });
    return merged;
  });
}

/** Replace an item with a substantively new formulation. The old one stays, `superseded`. */
export async function supersedeItem(
  db: DbOrTrx,
  itemId: string,
  input: {
    text: string;
    kind?: ItemKind | undefined;
    reason?: string | undefined;
    causedByItemId?: string | undefined;
  },
): Promise<ReasoningItemsTable> {
  return inTransaction(db, async (trx) => {
    const old = await requireItem(trx, itemId);
    const idea = await requireIdea(trx, old.idea_id);
    if (input.causedByItemId) {
      const cause = await requireItem(trx, input.causedByItemId);
      if (cause.idea_id !== idea.id) throw invalid('The cause must belong to the same idea.');
    }
    const replacement = await createItem(trx, {
      idea,
      kind: userKind(input.kind, old.kind),
      origin: 'user',
      text: input.text,
      via: 'supersede',
    });
    await createRelation(trx, {
      ideaId: idea.id,
      fromItemId: replacement.id,
      toItemId: old.id,
      type: 'supersedes',
      author: 'user',
      note: input.reason ?? null,
    });
    await recordDecision(trx, {
      itemId: old.id,
      type: 'supersede',
      author: 'user',
      rationale: input.reason,
      relatedItemIds: [replacement.id],
    });
    await logEvent(trx, {
      ideaId: idea.id,
      itemId: old.id,
      type: 'item.superseded',
      actor: 'user',
      payload: { replacementId: replacement.id, causedByItemId: input.causedByItemId ?? null },
    });
    return replacement;
  });
}

/** Reword an item. Small refinements only; use `supersedeItem` for a change of substance. */
export function reviseItem(
  db: DbOrTrx,
  itemId: string,
  input: { text: string; reason?: string | undefined; causedByItemId?: string | undefined },
) {
  return inTransaction(db, (trx) => addRevision(trx, { itemId, author: 'user', ...input }));
}

/** Attach user-supplied evidence to an item. Evidence is itself a node in the graph. */
export async function attachEvidence(
  db: DbOrTrx,
  itemId: string,
  input: {
    text: string;
    stance: 'for' | 'against';
    sourceTitle: string;
    url?: string | undefined;
    excerpt?: string | undefined;
  },
): Promise<ReasoningItemsTable> {
  if (!input.sourceTitle.trim()) throw invalid('Evidence needs a source.');
  return inTransaction(db, async (trx) => {
    const target = await requireItem(trx, itemId);
    const idea = await requireIdea(trx, target.idea_id);
    const evidence = await createItem(trx, {
      idea,
      kind: 'evidence',
      origin: 'user',
      text: input.text,
      via: 'evidence',
    });
    await trx
      .insertInto('evidence_details')
      .values({
        item_id: evidence.id,
        source_title: input.sourceTitle.trim(),
        url: input.url?.trim() || null,
        excerpt: input.excerpt?.trim() || null,
        created_at: nowIso(),
      })
      .execute();
    await createRelation(trx, {
      ideaId: idea.id,
      fromItemId: evidence.id,
      toItemId: target.id,
      type: input.stance === 'for' ? 'evidence_for' : 'evidence_against',
      author: 'user',
    });
    await logEvent(trx, {
      ideaId: idea.id,
      itemId: target.id,
      type: 'evidence.attached',
      actor: 'user',
      payload: {
        evidenceItemId: evidence.id,
        stance: input.stance,
        sourceTitle: input.sourceTitle,
      },
    });
    return evidence;
  });
}

/**
 * Post to an item's discussion thread and, optionally, ask the agent to reply. The
 * user's message is committed first, so it survives even if the agent call fails.
 */
export async function discuss(
  ctx: AppContext,
  itemId: string,
  input: { body: string; askAgent?: boolean | undefined },
): Promise<void> {
  const item = await requireItem(ctx.db, itemId);
  await inTransaction(ctx.db, (trx) =>
    postMessage(trx, { itemId, author: 'user', body: input.body }),
  );
  if (!input.askAgent) return;

  const snapshot = await buildSnapshot(ctx.db, item.idea_id);
  const thread = await ctx.db
    .selectFrom('discussion_messages')
    .select(['author', 'body'])
    .where('item_id', '=', itemId)
    .orderBy('seq')
    .execute();
  const target = snapshot.items.find((i) => i.id === itemId)!;
  await executePass(
    ctx,
    item.idea_id,
    discussRequest({ snapshot, item: target, thread }),
    async (trx, out: DiscussOutput, runId) => {
      const body = out.suggestion ? `${out.reply}\n\nSuggestion: ${out.suggestion}` : out.reply;
      await postMessage(trx, { itemId, author: 'agent', body, runId });
    },
  );
}

/**
 * Tangent -> new idea. The new idea records the item it grew from, and its root item
 * keeps the tangent's authorship: an AI-proposed tangent does not become "the user's
 * idea" by being promoted. If the user supplies their own framing, that framing is theirs.
 */
export async function promoteTangent(
  db: DbOrTrx,
  itemId: string,
  input: { framing?: string | undefined } = {},
): Promise<IdeasTable> {
  return inTransaction(db, async (trx) => {
    const item = await requireItem(trx, itemId);
    if (item.status !== 'tangent')
      throw invalid('Only items in the tangent library can be promoted.');
    const already = await trx
      .selectFrom('ideas')
      .select('id')
      .where('source_item_id', '=', itemId)
      .executeTakeFirst();
    if (already) throw conflict('This tangent has already been promoted to its own idea.');

    const framing = input.framing?.trim();
    const idea = await captureIdea(trx, {
      text: framing || item.text,
      source: 'promoted_tangent',
      rootOrigin: framing ? 'user' : item.origin,
      sourceItemId: item.id,
      sourceIdeaId: item.idea_id,
    });
    await logEvent(trx, {
      ideaId: item.idea_id,
      itemId: item.id,
      type: 'item.promoted',
      actor: 'user',
      payload: { newIdeaId: idea.id },
    });
    await logEvent(trx, {
      ideaId: idea.id,
      type: 'idea.promoted_from_tangent',
      actor: 'user',
      payload: { sourceIdeaId: item.idea_id, sourceItemId: item.id, userFraming: Boolean(framing) },
    });
    return idea;
  });
}
