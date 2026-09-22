/**
 * Write primitives. Every change to the reasoning state goes through one of these, and
 * each one appends to the audit log in the same transaction. Nothing here updates or
 * deletes history; the only UPDATEs are to projection columns on `reasoning_items`,
 * `ideas.stage` and `guided_sessions`.
 */
import type { Transaction } from 'kysely';
import type { Database, Db, DbOrTrx, ReasoningItemsTable } from '../db/schema';
import { conflict, invalid, notFound } from '../domain/errors';
import { newId } from '../domain/ids';
import { locateQuote } from '../domain/quotes';
import { statusAfterDecision, wouldCreateGenealogyCycle } from '../domain/rules';
import { currentOperation, requireUserAuthority } from './operation';
import type {
  Actor,
  AttentionReason,
  Author,
  DecisionType,
  EpistemicVerdict,
  EventType,
  ItemKind,
  ItemStatus,
  Origin,
  RelationType,
} from '../domain/vocabulary';

export const nowIso = () => new Date().toISOString();

/** Free text that accompanies a record. Blank becomes null; the user's words are kept exactly. */
const exactOrNull = (value: string | null | undefined, author: Author): string | null =>
  value?.trim() ? (author === 'user' ? value : value.trim()) : null;

/** Run `fn` in a transaction, joining the current one if there is one. */
export function inTransaction<T>(db: DbOrTrx, fn: (trx: Transaction<Database>) => Promise<T>) {
  return db.isTransaction ? fn(db as Transaction<Database>) : (db as Db).transaction().execute(fn);
}

export interface EventInput {
  ideaId: string | null;
  itemId?: string | null;
  type: EventType;
  actor: Actor;
  payload?: Record<string, unknown>;
  runId?: string | null;
}

/** Bookkeeping about attempts. Everything else is a change to the reasoning state. */
const NOT_A_STATE_CHANGE: readonly EventType[] = ['run.completed', 'run.failed', 'run.stale'];

/**
 * Append to the audit log. Any event that changes reasoning state also bumps the idea's
 * input version (`ideas.revision`) in the same transaction, which is what lets results
 * computed from an older state be recognised and refused.
 */
export async function logEvent(db: DbOrTrx, e: EventInput): Promise<void> {
  if (e.ideaId && !NOT_A_STATE_CHANGE.includes(e.type))
    await db
      .updateTable('ideas')
      .set((eb) => ({ revision: eb('revision', '+', 1) }))
      .where('id', '=', e.ideaId)
      .execute();
  await db
    .insertInto('events')
    .values({
      operation_id: currentOperation()?.id ?? null,
      idea_id: e.ideaId,
      item_id: e.itemId ?? null,
      type: e.type,
      actor: e.actor,
      payload_json: JSON.stringify(e.payload ?? {}),
      run_id: e.runId ?? null,
      created_at: nowIso(),
    })
    .execute();
}

export async function requireItem(db: DbOrTrx, itemId: string): Promise<ReasoningItemsTable> {
  const item = await db
    .selectFrom('reasoning_items')
    .selectAll()
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (!item) throw notFound('Item', itemId);
  return item;
}

export async function requireIdea(db: DbOrTrx, ideaId: string) {
  const idea = await db.selectFrom('ideas').selectAll().where('id', '=', ideaId).executeTakeFirst();
  if (!idea) throw notFound('Idea', ideaId);
  return idea;
}

const authorOf = (origin: Origin): Author => (origin === 'user' ? 'user' : 'agent');

export interface CreateItemInput {
  idea: { id: string; original_text: string };
  kind: ItemKind;
  origin: Origin;
  text: string;
  status?: ItemStatus;
  attentionReason?: AttentionReason | null;
  runId?: string | null;
  runKey?: string | null;
  /** Verbatim passages of the idea's original text that this item came from. */
  sourceQuotes?: string[];
  /** Extra context for the audit log (e.g. which operation created the item). */
  via?: string;
  /** Keep the text byte-for-byte (used for the captured idea). */
  verbatim?: boolean;
}

export async function createItem(
  db: DbOrTrx,
  input: CreateItemInput,
): Promise<ReasoningItemsTable> {
  const text = input.verbatim ? input.text : input.text.trim();
  if (!text.trim()) throw invalid('An item needs some text.');
  const now = nowIso();
  const status = input.status ?? 'open';
  const row: ReasoningItemsTable = {
    id: newId('itm'),
    idea_id: input.idea.id,
    kind: input.kind,
    origin: input.origin,
    status,
    text,
    epistemic_verdict: null,
    attention_reason:
      status === 'needs_user' ? (input.attentionReason ?? 'decision_required') : null,
    run_id: input.runId ?? null,
    run_key: input.runKey ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('reasoning_items').values(row).execute();
  await db
    .insertInto('item_revisions')
    .values({
      id: newId('rev'),
      item_id: row.id,
      seq: 1,
      text,
      author: authorOf(input.origin),
      reason: null,
      caused_by_item_id: null,
      run_id: row.run_id,
      created_at: now,
    })
    .execute();
  for (const quote of input.sourceQuotes ?? []) {
    const span = locateQuote(input.idea.original_text, quote);
    await db
      .insertInto('item_sources')
      .values({
        id: newId('src'),
        item_id: row.id,
        quote,
        // Unlocated quotes are kept for the record; see applyNewItems for what that implies.
        start_offset: span?.start ?? null,
        end_offset: span?.end ?? null,
        created_at: now,
      })
      .execute();
  }
  await logEvent(db, {
    ideaId: row.idea_id,
    itemId: row.id,
    type: 'item.created',
    actor: authorOf(input.origin),
    runId: row.run_id,
    payload: { kind: row.kind, origin: row.origin, status, via: input.via ?? null },
  });
  return row;
}

export interface CreateRelationInput {
  ideaId: string;
  fromItemId: string;
  toItemId: string;
  type: RelationType;
  author: Author;
  note?: string | null;
  runId?: string | null;
}

/** Create an edge. Idempotent for an identical (from, to, type). */
export async function createRelation(db: DbOrTrx, input: CreateRelationInput): Promise<string> {
  if (input.fromItemId === input.toItemId) throw invalid('An item cannot be related to itself.');
  const [from, to] = await Promise.all([
    requireItem(db, input.fromItemId),
    requireItem(db, input.toItemId),
  ]);
  if (from.idea_id !== input.ideaId || to.idea_id !== input.ideaId)
    throw invalid('Relations can only join items within the same idea.');

  const existing = await db
    .selectFrom('relations')
    .select(['id', 'from_item_id', 'to_item_id', 'type'])
    .where('idea_id', '=', input.ideaId)
    .execute();
  const duplicate = existing.find(
    (r) =>
      r.from_item_id === input.fromItemId &&
      r.to_item_id === input.toItemId &&
      r.type === input.type,
  );
  if (duplicate) return duplicate.id;

  const edges = existing.map((r) => ({
    fromItemId: r.from_item_id,
    toItemId: r.to_item_id,
    type: r.type,
  }));
  if (wouldCreateGenealogyCycle(edges, input))
    throw invalid(`A "${input.type}" edge here would make an item its own ancestor.`);

  const id = newId('rel');
  await db
    .insertInto('relations')
    .values({
      id,
      idea_id: input.ideaId,
      from_item_id: input.fromItemId,
      to_item_id: input.toItemId,
      type: input.type,
      author: input.author,
      note: input.note ?? null,
      run_id: input.runId ?? null,
      created_at: nowIso(),
    })
    .execute();
  await logEvent(db, {
    ideaId: input.ideaId,
    itemId: input.fromItemId,
    type: 'relation.created',
    actor: input.author,
    runId: input.runId ?? null,
    payload: { relationId: id, type: input.type, toItemId: input.toItemId },
  });
  return id;
}

export interface DecisionInput {
  itemId: string;
  type: DecisionType;
  author: Author;
  rationale?: string | null;
  qualification?: string | null;
  relatedItemIds?: string[];
  attentionReason?: AttentionReason | null;
  runId?: string | null;
}

/** Append a decision and update the item's status projection. History is never touched. */
export async function recordDecision(db: DbOrTrx, input: DecisionInput): Promise<ItemStatus> {
  const item = await requireItem(db, input.itemId);
  const toStatus = statusAfterDecision({
    kind: item.kind,
    status: item.status,
    decision: input.type,
    author: input.author,
    qualification: input.qualification,
    response: input.type === 'respond' ? input.rationale : null,
  });
  // A judgement call is always the user's. If an agent is the one executing it, it must
  // be carrying the user's own instruction, which is kept next to the decision.
  const authority =
    input.author === 'user'
      ? requireUserAuthority(`${input.type} an item`)
      : { relayedBy: null, userInstruction: null };
  const last = await db
    .selectFrom('decisions')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('item_id', '=', item.id)
    .executeTakeFirst();
  const now = nowIso();
  const id = newId('dec');
  await db
    .insertInto('decisions')
    .values({
      id,
      item_id: item.id,
      seq: (last?.seq ?? 0) + 1,
      type: input.type,
      author: input.author,
      from_status: item.status,
      to_status: toStatus,
      rationale: exactOrNull(input.rationale, input.author),
      qualification: exactOrNull(input.qualification, input.author),
      related_item_ids: JSON.stringify(input.relatedItemIds ?? []),
      created_at: now,
      relayed_by: authority.relayedBy,
      user_instruction: authority.userInstruction,
    })
    .execute();
  await db
    .updateTable('reasoning_items')
    .set({
      status: toStatus,
      attention_reason:
        toStatus === 'needs_user' ? (input.attentionReason ?? 'decision_required') : null,
      updated_at: now,
    })
    .where('id', '=', item.id)
    .execute();
  await logEvent(db, {
    ideaId: item.idea_id,
    itemId: item.id,
    type: 'item.decided',
    actor: input.author,
    runId: input.runId ?? null,
    payload: {
      decisionId: id,
      decision: input.type,
      from: item.status,
      to: toStatus,
      rationale: input.rationale ?? null,
      qualification: input.qualification ?? null,
    },
  });
  return toStatus;
}

export interface RevisionInput {
  itemId: string;
  text: string;
  author: Author;
  reason?: string | null;
  causedByItemId?: string | null;
  runId?: string | null;
  /** The agent that relayed a user-authored rewording, if any. */
  relayedBy?: string | null | undefined;
}

/** Reword an item. The previous wording stays in `item_revisions` for ever. */
export async function addRevision(db: DbOrTrx, input: RevisionInput): Promise<number> {
  const item = await requireItem(db, input.itemId);
  if (item.kind === 'original_idea')
    throw invalid('The original idea is permanent provenance and cannot be reworded.');
  if (!input.text.trim()) throw invalid('A revision needs some text.');
  const text = input.author === 'user' ? input.text : input.text.trim();
  if (text === item.text) throw conflict('The revision is identical to the current wording.');
  if (input.causedByItemId) {
    const cause = await requireItem(db, input.causedByItemId);
    if (cause.idea_id !== item.idea_id) throw invalid('The cause must belong to the same idea.');
  }
  const last = await db
    .selectFrom('item_revisions')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('item_id', '=', item.id)
    .executeTakeFirst();
  const seq = (last?.seq ?? 0) + 1;
  const now = nowIso();
  await db
    .insertInto('item_revisions')
    .values({
      id: newId('rev'),
      item_id: item.id,
      seq,
      text,
      author: input.author,
      reason: exactOrNull(input.reason, input.author),
      caused_by_item_id: input.causedByItemId ?? null,
      run_id: input.runId ?? null,
      created_at: now,
    })
    .execute();
  await db
    .updateTable('reasoning_items')
    .set({ text, updated_at: now })
    .where('id', '=', item.id)
    .execute();
  await logEvent(db, {
    ideaId: item.idea_id,
    itemId: item.id,
    type: 'item.revised',
    actor: input.author,
    payload: {
      seq,
      previousText: item.text,
      reason: input.reason ?? null,
      causedByItemId: input.causedByItemId ?? null,
      relayedBy: input.relayedBy ?? null,
    },
  });
  return seq;
}

export async function postMessage(
  db: DbOrTrx,
  input: { itemId: string; author: Author; body: string; runId?: string | null },
): Promise<{ id: string; seq: number }> {
  const item = await requireItem(db, input.itemId);
  if (!input.body.trim()) throw invalid('A message needs some text.');
  // The user's words are kept exactly as given; only the agent's are tidied.
  const body = input.author === 'user' ? input.body : input.body.trim();
  const last = await db
    .selectFrom('discussion_messages')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('item_id', '=', item.id)
    .executeTakeFirst();
  const seq = (last?.seq ?? 0) + 1;
  const id = newId('msg');
  await db
    .insertInto('discussion_messages')
    .values({
      id,
      item_id: item.id,
      seq,
      author: input.author,
      body,
      run_id: input.runId ?? null,
      created_at: nowIso(),
    })
    .execute();
  await logEvent(db, {
    ideaId: item.idea_id,
    itemId: item.id,
    type: 'message.posted',
    actor: input.author,
    runId: input.runId ?? null,
    payload: { messageId: id, seq },
  });
  return { id, seq };
}

export async function recordAssessment(
  db: DbOrTrx,
  input: {
    itemId: string;
    verdict: EpistemicVerdict;
    rationale: string;
    author: Author;
    runId?: string | null;
  },
): Promise<void> {
  const item = await requireItem(db, input.itemId);
  const now = nowIso();
  await db
    .insertInto('assessments')
    .values({
      id: newId('asm'),
      item_id: item.id,
      verdict: input.verdict,
      rationale: input.rationale,
      author: input.author,
      run_id: input.runId ?? null,
      created_at: now,
    })
    .execute();
  await db
    .updateTable('reasoning_items')
    .set({ epistemic_verdict: input.verdict, updated_at: now })
    .where('id', '=', item.id)
    .execute();
  await logEvent(db, {
    ideaId: item.idea_id,
    itemId: item.id,
    type: 'item.assessed',
    actor: input.author,
    runId: input.runId ?? null,
    payload: { verdict: input.verdict, rationale: input.rationale },
  });
}
