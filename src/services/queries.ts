/**
 * Read side: turns rows into the DTOs in src/api-types.ts. Derived facts (such as
 * "false premise, productive idea") are computed here from the stored graph; they are
 * never stored, so they cannot drift from the history that justifies them.
 */
import type {
  AssessmentDto,
  DecisionDto,
  EventDto,
  EvidenceDto,
  GraphDto,
  IdeaDto,
  IdeaSummaryDto,
  ItemDetailDto,
  ItemDto,
  ItemWithIdeaDto,
  LinkedItemDto,
  RelationDto,
  RunDto,
  SynthesisBodyDto,
  SynthesisDto,
} from '../api-types';
import type { IdeaSnapshot } from '../ai/passes';
import type { Selectable } from 'kysely';
import type { DbOrTrx, EventsTable, IdeasTable, RelationsTable } from '../db/schema';

type EventsRow = Selectable<EventsTable>;
import { notFound } from '../domain/errors';
import { evaluateReviewGate, premiseFailed, productiveDescendants } from '../domain/rules';
import { UNRESOLVED_STATUSES, type ItemStatus } from '../domain/vocabulary';
import { requireIdea, requireItem } from './store';

const toRelationDto = (r: RelationsTable): RelationDto => ({
  id: r.id,
  fromItemId: r.from_item_id,
  toItemId: r.to_item_id,
  type: r.type,
  author: r.author,
  note: r.note,
  createdAt: r.created_at,
});

const itemIdsOf = (db: DbOrTrx, ideaId: string) =>
  db.selectFrom('reasoning_items').select('id').where('idea_id', '=', ideaId);

/** All items of one idea as DTOs, in creation order, with derived fields filled in. */
export async function listIdeaItems(db: DbOrTrx, ideaId: string): Promise<ItemDto[]> {
  const [rows, relations, revisions, messages, runs, promoted] = await Promise.all([
    db
      .selectFrom('reasoning_items')
      .selectAll()
      .where('idea_id', '=', ideaId)
      .orderBy('id')
      .execute(),
    db.selectFrom('relations').selectAll().where('idea_id', '=', ideaId).execute(),
    db
      .selectFrom('item_revisions')
      .select(['item_id', (eb) => eb.fn.countAll<number>().as('n')])
      .where('item_id', 'in', itemIdsOf(db, ideaId))
      .groupBy('item_id')
      .execute(),
    db
      .selectFrom('discussion_messages')
      .select(['item_id', (eb) => eb.fn.countAll<number>().as('n')])
      .where('item_id', 'in', itemIdsOf(db, ideaId))
      .groupBy('item_id')
      .execute(),
    db.selectFrom('analysis_runs').select(['id', 'pass']).where('idea_id', '=', ideaId).execute(),
    db
      .selectFrom('ideas')
      .select(['id', 'source_item_id'])
      .where('source_idea_id', '=', ideaId)
      .execute(),
  ]);
  const revisionCount = new Map(revisions.map((r) => [r.item_id, Number(r.n)]));
  const messageCount = new Map(messages.map((m) => [m.item_id, Number(m.n)]));
  const passOfRun = new Map(runs.map((r) => [r.id, r.pass]));
  const promotedIdea = new Map(promoted.map((p) => [p.source_item_id, p.id]));
  const likes = rows.map((r) => ({
    id: r.id,
    status: r.status,
    epistemicVerdict: r.epistemic_verdict,
  }));
  const edges = relations.map((r) => ({
    fromItemId: r.from_item_id,
    toItemId: r.to_item_id,
    type: r.type,
  }));

  return rows.map((r, i) => ({
    id: r.id,
    ideaId: r.idea_id,
    kind: r.kind,
    origin: r.origin,
    status: r.status,
    text: r.text,
    epistemicVerdict: r.epistemic_verdict,
    attentionReason: r.attention_reason,
    createdByPass: r.run_id ? (passOfRun.get(r.run_id) ?? null) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revisionCount: revisionCount.get(r.id) ?? 0,
    messageCount: messageCount.get(r.id) ?? 0,
    productiveDescendantIds: premiseFailed(likes[i]!)
      ? productiveDescendants(r.id, likes, edges)
      : [],
    promotedIdeaId: promotedIdea.get(r.id) ?? null,
  }));
}

/** The idea as the reasoning passes see it. */
export async function buildSnapshot(db: DbOrTrx, ideaId: string): Promise<IdeaSnapshot> {
  const idea = await requireIdea(db, ideaId);
  const [rows, relations, qualifications] = await Promise.all([
    db
      .selectFrom('reasoning_items')
      .selectAll()
      .where('idea_id', '=', ideaId)
      .orderBy('id')
      .execute(),
    db.selectFrom('relations').selectAll().where('idea_id', '=', ideaId).execute(),
    db
      .selectFrom('decisions')
      .select(['item_id', 'qualification', 'seq'])
      .where('item_id', 'in', itemIdsOf(db, ideaId))
      .where('type', '=', 'qualify')
      .orderBy('seq')
      .execute(),
  ]);
  const latestQualification = new Map(qualifications.map((q) => [q.item_id, q.qualification]));
  return {
    idea: {
      id: idea.id,
      title: idea.title,
      originalText: idea.original_text,
      originalTextOrigin: rows.find((r) => r.kind === 'original_idea')?.origin ?? 'user',
    },
    items: rows.map((r) => ({
      id: r.id,
      runKey: r.run_key,
      kind: r.kind,
      origin: r.origin,
      status: r.status,
      text: r.text,
      epistemicVerdict: r.epistemic_verdict,
      qualification: r.status === 'qualified' ? (latestQualification.get(r.id) ?? null) : null,
    })),
    relations: relations.map((r) => ({
      fromItemId: r.from_item_id,
      toItemId: r.to_item_id,
      type: r.type,
    })),
    // Read BEFORE the items (requireIdea ran first): if anything changes in between, the
    // version is older than the data and the commit is refused. Never the other way round.
    inputVersion: Number(idea.revision),
  };
}

async function summarise(db: DbOrTrx, idea: IdeasTable): Promise<IdeaSummaryDto> {
  const [counts, session] = await Promise.all([
    db
      .selectFrom('reasoning_items')
      .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
      .where('idea_id', '=', idea.id)
      .where('kind', 'not in', ['original_idea', 'synthesis'])
      .groupBy('status')
      .execute(),
    db.selectFrom('guided_sessions').select('id').where('idea_id', '=', idea.id).executeTakeFirst(),
  ]);
  const n = (s: ItemStatus) => Number(counts.find((c) => c.status === s)?.n ?? 0);
  return {
    id: idea.id,
    title: idea.title,
    originalText: idea.original_text,
    source: idea.source,
    stage: idea.stage,
    sourceItemId: idea.source_item_id,
    sourceIdeaId: idea.source_idea_id,
    createdAt: idea.created_at,
    revision: Number(idea.revision),
    counts: {
      items: counts.reduce((sum, c) => sum + Number(c.n), 0),
      needsUser: n('needs_user'),
      open: n('open'),
      tangents: n('tangent'),
    },
    guidedSessionId: session?.id ?? null,
  };
}

export async function listIdeas(db: DbOrTrx): Promise<IdeaSummaryDto[]> {
  const ideas = await db.selectFrom('ideas').selectAll().orderBy('id', 'desc').execute();
  return Promise.all(ideas.map((i) => summarise(db, i)));
}

export async function getIdea(db: DbOrTrx, ideaId: string): Promise<IdeaDto> {
  const idea = await requireIdea(db, ideaId);
  const [summary, items, latest] = await Promise.all([
    summarise(db, idea),
    db
      .selectFrom('reasoning_items')
      .select(['id', 'status', 'kind'])
      .where('idea_id', '=', ideaId)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('syntheses')
      .select((eb) => eb.fn.max('version').as('version'))
      .where('idea_id', '=', ideaId)
      .executeTakeFirst(),
  ]);
  const root = items.find((i) => i.kind === 'original_idea');
  if (!root) throw notFound('Root item for idea', ideaId);

  let promotedFrom: IdeaDto['promotedFrom'] = null;
  if (idea.source_item_id && idea.source_idea_id) {
    const [sourceItem, sourceIdea] = await Promise.all([
      requireItem(db, idea.source_item_id),
      requireIdea(db, idea.source_idea_id),
    ]);
    promotedFrom = {
      ideaId: sourceIdea.id,
      ideaTitle: sourceIdea.title,
      itemId: sourceItem.id,
      itemText: sourceItem.text,
    };
  }
  return {
    ...summary,
    rootItemId: root.id,
    gate: evaluateReviewGate(items),
    promotedFrom,
    latestSynthesisVersion: latest?.version ?? null,
  };
}

export async function getGraph(db: DbOrTrx, ideaId: string): Promise<GraphDto> {
  await requireIdea(db, ideaId);
  const [nodes, relations] = await Promise.all([
    listIdeaItems(db, ideaId),
    db.selectFrom('relations').selectAll().where('idea_id', '=', ideaId).orderBy('id').execute(),
  ]);
  return { ideaId, nodes, edges: relations.map(toRelationDto) };
}

// ---------------------------------------------------------------------------
// The three list views. Each works for one idea or across the whole workspace.
// ---------------------------------------------------------------------------

async function itemsByStatus(
  db: DbOrTrx,
  statuses: readonly ItemStatus[],
  ideaId?: string,
): Promise<ItemWithIdeaDto[]> {
  let ideasQuery = db.selectFrom('ideas').select(['id', 'title']).orderBy('id', 'desc');
  if (ideaId) ideasQuery = ideasQuery.where('id', '=', ideaId);
  const ideas = await ideasQuery.execute();
  const out: ItemWithIdeaDto[] = [];
  for (const idea of ideas) {
    const items = await listIdeaItems(db, idea.id);
    for (const item of items) {
      if (!statuses.includes(item.status)) continue;
      // The captured idea and synthesis records are not things to resolve.
      if (['original_idea', 'synthesis', 'conclusion'].includes(item.kind)) continue;
      out.push({ ...item, ideaTitle: idea.title });
    }
  }
  return out;
}

/** Inbox / Needs Attention: items the agent has explicitly put to the user. */
export const listInbox = (db: DbOrTrx, ideaId?: string) =>
  itemsByStatus(db, ['needs_user'], ideaId);
/** Open Questions: every item for which no conclusion has been reached. */
export const listOpenQuestions = (db: DbOrTrx, ideaId?: string) =>
  itemsByStatus(db, UNRESOLVED_STATUSES, ideaId);
/** Tangent Library: ideas set aside, ready to be explored on their own. */
export const listTangents = (db: DbOrTrx, ideaId?: string) =>
  itemsByStatus(db, ['tangent'], ideaId);

// ---------------------------------------------------------------------------
// Item detail: everything needed to answer "where did this come from?"
// ---------------------------------------------------------------------------

export async function getItemDetail(db: DbOrTrx, itemId: string): Promise<ItemDetailDto> {
  const row = await requireItem(db, itemId);
  const idea = await requireIdea(db, row.idea_id);
  const allItems = await listIdeaItems(db, row.idea_id);
  const byId = new Map(allItems.map((i) => [i.id, i]));
  const item = byId.get(itemId)!;

  const [revisions, sources, messages, decisions, assessments, relations, events, evidenceRows] =
    await Promise.all([
      db
        .selectFrom('item_revisions')
        .selectAll()
        .where('item_id', '=', itemId)
        .orderBy('seq')
        .execute(),
      db
        .selectFrom('item_sources')
        .selectAll()
        .where('item_id', '=', itemId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('discussion_messages')
        .selectAll()
        .where('item_id', '=', itemId)
        .orderBy('seq')
        .execute(),
      db.selectFrom('decisions').selectAll().where('item_id', '=', itemId).orderBy('seq').execute(),
      db
        .selectFrom('assessments')
        .selectAll()
        .where('item_id', '=', itemId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('relations')
        .selectAll()
        .where((eb) => eb.or([eb('from_item_id', '=', itemId), eb('to_item_id', '=', itemId)]))
        .orderBy('id')
        .execute(),
      db.selectFrom('events').selectAll().where('item_id', '=', itemId).orderBy('seq').execute(),
      db
        .selectFrom('evidence_details')
        .selectAll()
        .where('item_id', 'in', itemIdsOf(db, row.idea_id))
        .execute(),
    ]);

  const links: LinkedItemDto[] = relations.flatMap((r) => {
    const direction = r.from_item_id === itemId ? ('out' as const) : ('in' as const);
    const other = byId.get(direction === 'out' ? r.to_item_id : r.from_item_id);
    return other ? [{ relation: toRelationDto(r), direction, item: other }] : [];
  });

  const details = new Map(evidenceRows.map((e) => [e.item_id, e]));
  const evidence: EvidenceDto[] = links.flatMap((l) => {
    const isEvidence = l.relation.type === 'evidence_for' || l.relation.type === 'evidence_against';
    const detail = details.get(l.item.id);
    if (!isEvidence || l.direction !== 'in' || !detail) return [];
    return [
      {
        item: l.item,
        stance: l.relation.type === 'evidence_for' ? ('for' as const) : ('against' as const),
        sourceTitle: detail.source_title,
        url: detail.url,
        excerpt: detail.excerpt,
      },
    ];
  });

  return {
    item,
    idea: { id: idea.id, title: idea.title, originalText: idea.original_text },
    revisions: revisions.map((r) => ({
      id: r.id,
      seq: r.seq,
      text: r.text,
      author: r.author,
      reason: r.reason,
      causedByItemId: r.caused_by_item_id,
      createdAt: r.created_at,
    })),
    sources: sources.map((s) => ({
      id: s.id,
      quote: s.quote,
      startOffset: s.start_offset,
      endOffset: s.end_offset,
    })),
    messages: messages.map((m) => ({
      id: m.id,
      seq: m.seq,
      author: m.author,
      body: m.body,
      createdAt: m.created_at,
    })),
    decisions: decisions.map((d): DecisionDto => ({
      id: d.id,
      seq: d.seq,
      type: d.type,
      author: d.author,
      fromStatus: d.from_status,
      toStatus: d.to_status,
      rationale: d.rationale,
      qualification: d.qualification,
      relatedItemIds: JSON.parse(d.related_item_ids) as string[],
      createdAt: d.created_at,
      relayedBy: d.relayed_by,
      userInstruction: d.user_instruction,
    })),
    assessments: assessments.map((a): AssessmentDto => ({
      id: a.id,
      verdict: a.verdict,
      rationale: a.rationale,
      author: a.author,
      createdAt: a.created_at,
    })),
    evidence,
    links,
    events: await toEventDtos(db, events),
  };
}

/** Events with the operation envelope they belong to (who executed it, through what). */
async function toEventDtos(db: DbOrTrx, events: EventsRow[]): Promise<EventDto[]> {
  const ids = [...new Set(events.flatMap((e) => (e.operation_id ? [e.operation_id] : [])))];
  const operations = ids.length
    ? await db.selectFrom('operations').selectAll().where('id', 'in', ids).execute()
    : [];
  const byId = new Map(operations.map((o) => [o.id, o]));
  return events.map((e) => {
    const op = e.operation_id ? byId.get(e.operation_id) : undefined;
    return {
      seq: e.seq,
      type: e.type,
      actor: e.actor,
      itemId: e.item_id,
      payload: JSON.parse(e.payload_json) as Record<string, unknown>,
      createdAt: e.created_at,
      operation: op
        ? {
            client: op.client,
            executedBy: op.executed_by,
            agentName: op.agent_name,
            clientSession: op.client_session,
            userInstruction: op.user_instruction,
          }
        : null,
    };
  });
}

export async function listIdeaEvents(db: DbOrTrx, ideaId: string): Promise<EventDto[]> {
  await requireIdea(db, ideaId);
  const events = await db
    .selectFrom('events')
    .selectAll()
    .where('idea_id', '=', ideaId)
    .orderBy('seq')
    .execute();
  return toEventDtos(db, events);
}

export async function listRuns(db: DbOrTrx, ideaId: string): Promise<RunDto[]> {
  await requireIdea(db, ideaId);
  const runs = await db
    .selectFrom('analysis_runs')
    .selectAll()
    .where('idea_id', '=', ideaId)
    .orderBy('id')
    .execute();
  return runs.map((r) => ({
    id: r.id,
    pass: r.pass,
    provider: r.provider,
    model: r.model,
    promptVersion: r.prompt_version,
    status: r.status,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    inputVersion: r.input_version,
    modelSource: r.model_source,
    authMode: r.auth_mode,
  }));
}

/** A synthesis version (latest by default), with every item it references. */
export async function getSynthesis(
  db: DbOrTrx,
  ideaId: string,
  version?: number,
): Promise<SynthesisDto | null> {
  await requireIdea(db, ideaId);
  let query = db
    .selectFrom('syntheses')
    .innerJoin('analysis_runs', 'analysis_runs.id', 'syntheses.run_id')
    .select([
      'syntheses.id',
      'syntheses.idea_id',
      'syntheses.item_id',
      'syntheses.version',
      'syntheses.run_id',
      'syntheses.body_json',
      'syntheses.created_at',
      'analysis_runs.provider',
      'analysis_runs.model',
    ])
    .where('syntheses.idea_id', '=', ideaId);
  query = version
    ? query.where('syntheses.version', '=', version)
    : query.orderBy('syntheses.version', 'desc');
  const row = await query.executeTakeFirst();
  if (!row) return null;
  const body = JSON.parse(row.body_json) as SynthesisBodyDto;
  const refs = new Set<string>([
    ...body.initialThought.refs,
    ...[
      ...body.whatChanged,
      ...body.rejected,
      ...body.uncertain,
      ...body.conclusions,
      ...body.evidence,
      ...body.openQuestions,
    ].flatMap((l) => l.refs),
    ...body.conclusions.map((c) => c.itemId),
    ...body.archivedTangents.map((t) => t.itemId),
  ]);
  const items = await listIdeaItems(db, ideaId);
  return {
    id: row.id,
    ideaId: row.idea_id,
    itemId: row.item_id,
    version: row.version,
    runId: row.run_id,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    body,
    referencedItems: items.filter((i) => refs.has(i.id)),
  };
}
