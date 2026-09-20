/**
 * Operations on reasoning items at the review gate. Every operation is additive: parents
 * are never erased, authorship never changes, and each step leaves decision rows and audit
 * events behind.
 *
 * AUTHOR vs APPROVER. Anything that carries text takes an explicit `author`:
 *   - `user`   the user's own words (typed in the web UI, or relayed verbatim by an agent)
 *   - `agent`  words the agent wrote, even if the user asked for them and approves them
 * The structural decision itself (split, merge, supersede, promote) is always the user's,
 * recorded separately in `decisions`; when an agent executes it, `recordDecision` insists
 * on the user's own instruction (see services/operation.ts).
 */
import { discussRequest } from '../ai/passes';
import type { DiscussOutput } from '../ai/schemas';
import type { DbOrTrx, IdeasTable, ReasoningItemsTable } from '../db/schema';
import { conflict, forbidden, invalid } from '../domain/errors';
import {
  USER_CREATABLE_KINDS,
  type Author,
  type DecisionType,
  type ItemKind,
  type Origin,
} from '../domain/vocabulary';
import type { AppContext } from './context';
import { captureIdea } from './ideas';
import { currentOperation, requireUserAuthority, StaleInputError } from './operation';
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

/**
 * Who wrote a piece of text. The web user acting directly may leave it out (it is theirs).
 * An agent may not: a missing author must never quietly become "the user said this".
 */
function resolveAuthor(author: Author | undefined, what: string): Author {
  if (author) return author;
  if (currentOperation()?.meta.executedBy === 'agent')
    throw invalid(`Say who wrote ${what}: author "user" (their exact words) or "agent" (yours).`);
  return 'user';
}

const originOf = (author: Author): Origin => (author === 'agent' ? 'agent' : 'user');

function creatableKind(kind: ItemKind | undefined, fallback: ItemKind): ItemKind {
  const chosen = kind ?? (USER_CREATABLE_KINDS.includes(fallback) ? fallback : 'hypothesis');
  if (!USER_CREATABLE_KINDS.includes(chosen))
    throw invalid(`A "${chosen}" item cannot be created by hand.`);
  return chosen;
}

export interface DecideInput {
  decision: DecisionType;
  rationale?: string | undefined;
  qualification?: string | undefined;
}

/** Accept, qualify, reject, reopen, or set aside as a tangent. The user's call; the discussion stays. */
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
  /** Who wrote this part. Defaults to the user. */
  author?: Author | undefined;
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
      const childAuthor = resolveAuthor(child.author, 'each part');
      const row = await createItem(trx, {
        idea,
        kind: creatableKind(child.kind, parent.kind),
        origin: originOf(childAuthor),
        text: child.text,
        verbatim: childAuthor === 'user', // the user's words are kept exactly
        via: 'split',
      });
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: row.id,
        toItemId: parent.id,
        type: 'derived_from',
        author: 'user', // the split, and so this genealogy, is the user's decision
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
      payload: { childIds, childAuthors: input.children.map((c) => c.author ?? 'user') },
    });
    return children;
  });
}

/**
 * Grow a new item out of an existing one without retiring the parent: a new hypothesis,
 * a correction, a question needing research, or (with `asTangent`) a tangent. No judgement
 * call is involved, so an agent may do this on its own account, as the agent.
 */
export async function branchItem(
  db: DbOrTrx,
  itemId: string,
  input: {
    text: string;
    kind?: ItemKind | undefined;
    asTangent?: boolean | undefined;
    author?: Author | undefined;
  },
): Promise<ReasoningItemsTable> {
  const author = resolveAuthor(input.author, 'the new item');
  return inTransaction(db, async (trx) => {
    const parent = await requireItem(trx, itemId);
    const idea = await requireIdea(trx, parent.idea_id);
    const child = await createItem(trx, {
      idea,
      kind: creatableKind(input.kind, input.asTangent ? 'question' : 'hypothesis'),
      origin: originOf(author),
      text: input.text,
      verbatim: author === 'user',
      via: input.asTangent ? 'tangent' : 'branch',
    });
    if (input.asTangent) {
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: child.id,
        toItemId: parent.id,
        type: 'tangent_of',
        author,
      });
      await recordDecision(trx, {
        itemId: child.id,
        type: 'mark_tangent',
        author,
        rationale: 'Created as a tangent.',
      });
    } else {
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: parent.id,
        toItemId: child.id,
        type: 'branches_to',
        author,
      });
    }
    await logEvent(trx, {
      ideaId: idea.id,
      itemId: parent.id,
      type: 'item.branched',
      actor: author,
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
    author?: Author | undefined;
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
    const textAuthor = resolveAuthor(input.author, 'the merged text');
    const merged = await createItem(trx, {
      idea,
      kind: creatableKind(input.kind, first.kind),
      origin: originOf(textAuthor),
      text: input.text,
      verbatim: textAuthor === 'user',
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
      payload: { sourceIds: ids, textAuthor },
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
    author?: Author | undefined;
  },
): Promise<ReasoningItemsTable> {
  return inTransaction(db, async (trx) => {
    const old = await requireItem(trx, itemId);
    const idea = await requireIdea(trx, old.idea_id);
    if (input.causedByItemId) {
      const cause = await requireItem(trx, input.causedByItemId);
      if (cause.idea_id !== idea.id) throw invalid('The cause must belong to the same idea.');
    }
    const textAuthor = resolveAuthor(input.author, 'the new formulation');
    const replacement = await createItem(trx, {
      idea,
      kind: creatableKind(input.kind, old.kind),
      origin: originOf(textAuthor),
      text: input.text,
      verbatim: textAuthor === 'user',
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
      payload: {
        replacementId: replacement.id,
        causedByItemId: input.causedByItemId ?? null,
        textAuthor,
      },
    });
    return replacement;
  });
}

/**
 * Reword an item. Small refinements only; use `supersedeItem` for a change of substance.
 * An agent may only reword what the agent itself originated: rewording the user's thought
 * would put the agent's words under the user's name. It should propose a branch or a
 * superseding item instead, for the user to decide on.
 */
export function reviseItem(
  db: DbOrTrx,
  itemId: string,
  input: {
    text: string;
    reason?: string | undefined;
    causedByItemId?: string | undefined;
    author?: Author | undefined;
  },
) {
  const author = resolveAuthor(input.author, 'the new wording');
  return inTransaction(db, async (trx) => {
    let relayedBy: string | null = null;
    if (author === 'agent') {
      const item = await requireItem(trx, itemId);
      if (item.origin !== 'agent')
        throw forbidden(
          "An agent may not reword the user's thought. Propose a branch or a superseding item for the user to decide on.",
        );
    } else {
      // Rewording changes what an existing item currently SAYS. When an agent relays it,
      // "author: user" alone is not enough: the user's instruction is required and kept.
      relayedBy = requireUserAuthority('reword an item').relayedBy;
    }
    return addRevision(trx, { itemId, ...input, author, relayedBy });
  });
}

/** Attach evidence to an item. Evidence is itself a node in the graph. */
export async function attachEvidence(
  db: DbOrTrx,
  itemId: string,
  input: {
    text: string;
    stance: 'for' | 'against';
    sourceTitle: string;
    url?: string | undefined;
    excerpt?: string | undefined;
    author?: Author | undefined;
  },
): Promise<ReasoningItemsTable> {
  if (!input.sourceTitle.trim()) throw invalid('Evidence needs a source.');
  const author = resolveAuthor(input.author, 'the evidence');
  return inTransaction(db, async (trx) => {
    const target = await requireItem(trx, itemId);
    const idea = await requireIdea(trx, target.idea_id);
    const evidence = await createItem(trx, {
      idea,
      kind: 'evidence',
      origin: originOf(author),
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
      author,
    });
    await logEvent(trx, {
      ideaId: idea.id,
      itemId: target.id,
      type: 'evidence.attached',
      actor: author,
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
 * Add one contribution to an item's thread. No model is involved: the web UI, or an agent
 * in a VS Code panel, posts the user's words as the user's and its own words as its own.
 */
export function postContribution(
  db: DbOrTrx,
  itemId: string,
  input: { author: Author; body: string },
) {
  return inTransaction(db, (trx) => postMessage(trx, { itemId, ...input }));
}

/** Ask the configured provider to reply in an item's thread. */
export async function requestAgentReply(
  ctx: AppContext,
  itemId: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<void> {
  const item = await requireItem(ctx.db, itemId);
  const snapshot = await buildSnapshot(ctx.db, item.idea_id);
  const thread = await ctx.db
    .selectFrom('discussion_messages')
    .select(['author', 'body', 'seq'])
    .where('item_id', '=', itemId)
    .orderBy('seq')
    .execute();
  const target = snapshot.items.find((i) => i.id === itemId)!;
  const readSeq = thread.at(-1)?.seq ?? 0;
  await executePass(
    ctx,
    item.idea_id,
    discussRequest({
      snapshot,
      item: target,
      thread: thread.map(({ author, body }) => ({ author, body })),
    }),
    async (trx, out: DiscussOutput, runId) => {
      // A reply must directly follow the thread it was written for. If the user said
      // something more while the model was writing, this reply never saw it: refuse it
      // (it is kept as a stale run) so that a fresh one can answer the whole thread.
      const latest = await trx
        .selectFrom('discussion_messages')
        .select((eb) => eb.fn.max('seq').as('seq'))
        .where('item_id', '=', itemId)
        .executeTakeFirst();
      if ((latest?.seq ?? 0) !== readSeq)
        throw new StaleInputError(readSeq, latest?.seq ?? 0, 'The discussion thread');
      const body = out.suggestion ? `${out.reply}\n\nSuggestion: ${out.suggestion}` : out.reply;
      await postMessage(trx, { itemId, author: 'agent', body, runId });
    },
    // A reply is bound to its THREAD (checked above), not to the whole idea: an unrelated
    // decision elsewhere does not invalidate it. The idea version it saw is still recorded.
    { readVersion: snapshot.inputVersion, checkVersion: false, signal: options.signal },
  );
}

/**
 * Post the user's message and, optionally, get a provider reply in the same call. The
 * user's message is committed first, so it survives even if the agent call fails.
 */
export async function discuss(
  ctx: AppContext,
  itemId: string,
  input: { body: string; askAgent?: boolean | undefined },
): Promise<void> {
  await postContribution(ctx.db, itemId, { author: 'user', body: input.body });
  if (input.askAgent) await requestAgentReply(ctx, itemId);
}

/**
 * Tangent -> new idea. The new idea records the item it grew from, and its root item
 * keeps the tangent's authorship: an AI-proposed tangent does not become "the user's
 * idea" by being promoted. A reframing is attributed to whoever wrote it.
 */
export async function promoteTangent(
  db: DbOrTrx,
  itemId: string,
  input: { framing?: string | undefined; framingAuthor?: Author | undefined } = {},
): Promise<IdeasTable> {
  return inTransaction(db, async (trx) => {
    requireUserAuthority('promote a tangent to a new idea');
    const item = await requireItem(trx, itemId);
    if (item.status !== 'tangent')
      throw invalid('Only items in the tangent library can be promoted.');
    const already = await trx
      .selectFrom('ideas')
      .select('id')
      .where('source_item_id', '=', itemId)
      .executeTakeFirst();
    if (already) throw conflict('This tangent has already been promoted to its own idea.');

    // A reframing is stored exactly as written, and must say whose words it is.
    const framing = input.framing?.trim() ? input.framing : undefined;
    const framingAuthor = framing ? resolveAuthor(input.framingAuthor, 'the reframing') : null;
    const idea = await captureIdea(trx, {
      text: framing ?? item.text,
      source: 'promoted_tangent',
      rootOrigin: framingAuthor ? originOf(framingAuthor) : item.origin,
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
      payload: {
        sourceIdeaId: item.idea_id,
        sourceItemId: item.id,
        framingAuthor,
      },
    });
    return idea;
  });
}
