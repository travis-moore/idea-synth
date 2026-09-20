/**
 * Applying validated pass output to the reasoning state.
 *
 * These functions are the ONLY way model-produced reasoning enters the database, and they
 * do not care who produced it: a configured provider, a local subscription worker, or the
 * agent in a VS Code panel submitting through the CLI all land here, after the same schema
 * validation, inside one transaction (see `commitPass` in pipeline.ts).
 */
import type { Transaction } from 'kysely';
import type { EpistemicOutput, NewItemOutput, SynthesizeOutput } from '../ai/schemas';
import type { SynthesisBodyDto } from '../api-types';
import type { Database, DbOrTrx, IdeasTable } from '../db/schema';
import { DomainError, invalid } from '../domain/errors';
import { newId } from '../domain/ids';
import { locateQuote } from '../domain/quotes';
import { evaluateReviewGate } from '../domain/rules';

export type { ItemPass } from '../domain/remit';
import { ALLOWED_KINDS, ALLOWED_LINKS, INBOUND_LINKS, type ItemPass } from '../domain/remit';
import { setStage } from './ideas';
import {
  createItem,
  createRelation,
  logEvent,
  nowIso,
  recordAssessment,
  recordDecision,
} from './store';

type Trx = Transaction<Database>;

/** Resolve a model-supplied reference: a key from this output, or an existing item id. */
function resolver(existingIds: Set<string>, keyToId: Map<string, string>) {
  return (ref: string): string => {
    const id = keyToId.get(ref) ?? (existingIds.has(ref) ? ref : undefined);
    if (!id) throw invalid(`Model output refers to an unknown item "${ref}".`);
    return id;
  };
}

async function existingItemIds(trx: Trx, ideaId: string): Promise<Set<string>> {
  const rows = await trx
    .selectFrom('reasoning_items')
    .select('id')
    .where('idea_id', '=', ideaId)
    .execute();
  return new Set(rows.map((r) => r.id));
}

/** Create the items a pass proposed, then their edges (so they can refer to one another). */
export async function applyNewItems(
  trx: Trx,
  idea: IdeasTable,
  runId: string,
  pass: ItemPass,
  items: Array<NewItemOutput & { source_quotes?: string[] }>,
): Promise<Record<string, string>> {
  const existing = await existingItemIds(trx, idea.id);
  const root = await trx
    .selectFrom('reasoning_items')
    .select(['id', 'origin'])
    .where('idea_id', '=', idea.id)
    .where('kind', '=', 'original_idea')
    .executeTakeFirstOrThrow();

  const keyToId = new Map<string, string>();
  for (const item of items) {
    if (!ALLOWED_KINDS[pass].includes(item.kind))
      throw invalid(`The ${pass} pass may not create items of kind "${item.kind}".`);
    if (keyToId.has(item.key)) throw invalid(`Duplicate item key "${item.key}" in model output.`);
    if (pass !== 'extract' && item.links.length === 0)
      throw invalid(`Item "${item.key}" is not linked to anything it arose from.`);
    for (const link of item.links) {
      if (!ALLOWED_LINKS[pass].includes(link.type))
        throw invalid(`The ${pass} pass may not create "${link.type}" edges.`);
      if (link.direction === 'in' && !INBOUND_LINKS.includes(link.type))
        throw invalid(`A "${link.type}" edge cannot point at a newly created item.`);
    }

    // `extracted_from_user` is a permanent claim that the user said this. It is only
    // made when the captured text really is the user's AND a quote is found in it.
    // Otherwise the item is the agent's, and an unfounded extraction is put to the user.
    const located = (item.source_quotes ?? []).some((q) => locateQuote(idea.original_text, q));
    const fromUser = pass === 'extract' && root.origin === 'user' && located;
    const unfounded = pass === 'extract' && root.origin === 'user' && !located;
    // Builder output is a proposal made after the gate; it must not re-close the gate
    // behind the user's back, so it is never `needs_user`.
    const needsUser = unfounded || (item.needs_user && !item.is_tangent && pass !== 'builder');

    const row = await createItem(trx, {
      idea,
      kind: item.kind,
      origin: fromUser ? 'extracted_from_user' : 'agent',
      text: item.text,
      status: needsUser ? 'needs_user' : 'open',
      attentionReason: unfounded ? 'clarification_needed' : (item.attention_reason ?? null),
      runId,
      runKey: item.key,
      sourceQuotes: item.source_quotes ?? [],
      via: pass,
    });
    keyToId.set(item.key, row.id);
  }

  const resolve = resolver(existing, keyToId);
  for (const item of items) {
    const itemId = keyToId.get(item.key)!;
    for (const link of item.links) {
      const other = resolve(link.to);
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: link.direction === 'in' ? other : itemId,
        toItemId: link.direction === 'in' ? itemId : other,
        type: link.type,
        author: 'agent',
        note: link.note ?? null,
        runId,
      });
    }
    // Every extracted item traces back to the captured idea, directly or via its parent.
    const hasParent = item.links.some((l) => l.type === 'derived_from' && l.direction === 'out');
    if (pass === 'extract' && !hasParent)
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: itemId,
        toItemId: root.id,
        type: 'derived_from',
        author: 'agent',
        runId,
      });
    if (item.is_tangent)
      await recordDecision(trx, {
        itemId,
        type: 'mark_tangent',
        author: 'agent',
        rationale: 'Set aside by the Explorer as interesting but off the main line.',
        runId,
      });
  }
  return Object.fromEntries(keyToId);
}

export async function applyFlags(
  trx: Trx,
  ideaId: string,
  runId: string,
  flags: EpistemicOutput['flags'],
): Promise<void> {
  const existing = await existingItemIds(trx, ideaId);
  for (const flag of flags) {
    if (!existing.has(flag.item))
      throw invalid(`Model output flags an unknown item "${flag.item}".`);
    const item = await trx
      .selectFrom('reasoning_items')
      .select('status')
      .where('id', '=', flag.item)
      .executeTakeFirstOrThrow();
    if (item.status !== 'open') continue; // never override a decision the user has made
    await recordDecision(trx, {
      itemId: flag.item,
      type: 'flag_needs_user',
      author: 'agent',
      rationale: flag.note ?? null,
      attentionReason: flag.reason,
      runId,
    });
  }
}

export async function applyEpistemic(
  trx: Trx,
  idea: IdeasTable,
  runId: string,
  out: EpistemicOutput,
): Promise<Record<string, string>> {
  const existing = await existingItemIds(trx, idea.id);
  for (const a of out.assessments) {
    if (!existing.has(a.item)) throw invalid(`Model output assesses an unknown item "${a.item}".`);
    await recordAssessment(trx, {
      itemId: a.item,
      verdict: a.verdict,
      rationale: a.rationale,
      author: 'agent',
      runId,
    });
  }
  const created = await applyNewItems(trx, idea, runId, 'epistemic', out.corrections);
  const resolve = resolver(existing, new Map(Object.entries(created)));
  for (const e of out.evidence) {
    const about = resolve(e.about);
    const row = await createItem(trx, {
      idea,
      kind: 'evidence',
      origin: 'agent',
      text: e.text,
      runId,
      runKey: e.key,
      via: 'epistemic',
    });
    created[e.key] = row.id;
    await trx
      .insertInto('evidence_details')
      .values({
        item_id: row.id,
        source_title: e.source_title,
        url: e.url ?? null,
        excerpt: e.excerpt ?? null,
        created_at: nowIso(),
      })
      .execute();
    await createRelation(trx, {
      ideaId: idea.id,
      fromItemId: row.id,
      toItemId: about,
      type: e.stance === 'for' ? 'evidence_for' : 'evidence_against',
      author: 'agent',
      runId,
    });
    await logEvent(trx, {
      ideaId: idea.id,
      itemId: about,
      type: 'evidence.attached',
      actor: 'agent',
      runId,
      payload: { evidenceItemId: row.id, stance: e.stance, sourceTitle: e.source_title },
    });
  }
  await applyFlags(trx, idea.id, runId, out.flags);
  return created;
}

export async function currentGate(db: DbOrTrx, ideaId: string) {
  const items = await db
    .selectFrom('reasoning_items')
    .select(['id', 'status', 'kind'])
    .where('idea_id', '=', ideaId)
    .execute();
  return evaluateReviewGate(items);
}

/**
 * A user's decision to proceed past the review gate. It names the items the user was
 * shown and chose to leave unresolved, so it can only ever authorise THOSE items: anything
 * that starts needing the user afterwards blocks again.
 */
export interface GateOverride {
  blockingItemIds: string[];
  /**
   * Set by the client layer when an agent relayed the override: who relayed it and the
   * user's own words. The override itself is always the user's; whoever later RUNS the
   * synthesis (a provider, a worker) is not the one authorising it.
   */
  relayedBy?: string | null | undefined;
  userInstruction?: string | null | undefined;
}

/**
 * Enforce the human review gate. Returns the ids that were overridden (empty if the gate
 * was simply clear). Throws 409 with the blocking ids so a client can show them.
 */
export async function enforceGate(
  db: DbOrTrx,
  ideaId: string,
  override: GateOverride | undefined,
): Promise<string[]> {
  const gate = await currentGate(db, ideaId);
  if (gate.canProceed) return [];
  const covered = new Set(override?.blockingItemIds ?? []);
  const uncovered = gate.blockingItemIds.filter((id) => !covered.has(id));
  if (!override)
    throw new DomainError(
      'conflict',
      `${gate.blockingItemIds.length} item(s) still need your input. Review them first, or proceed anyway.`,
      { reason: 'review_gate', blockingItemIds: gate.blockingItemIds },
    );
  if (uncovered.length > 0)
    throw new DomainError(
      'conflict',
      `${uncovered.length} item(s) that need your input are not covered by this override (they appeared after it was given). Review them, or override again having seen them.`,
      { reason: 'review_gate', blockingItemIds: gate.blockingItemIds, uncoveredItemIds: uncovered },
    );
  return gate.blockingItemIds;
}

export interface SynthesisApplied {
  synthesisItemId: string;
  version: number;
  conclusionItemIds: string[];
  archivedTangentIds: string[];
}

export async function applySynthesis(
  trx: Trx,
  idea: IdeasTable,
  runId: string,
  out: SynthesizeOutput,
  override: GateOverride | undefined,
): Promise<SynthesisApplied> {
  // The gate is decided here, in the transaction that commits the synthesis, so nothing
  // that started needing the user while the model was thinking can be skipped silently,
  // and an override is only ever recorded for a synthesis that actually happened.
  const overridden = await enforceGate(trx, idea.id, override);
  if (overridden.length > 0)
    await logEvent(trx, {
      ideaId: idea.id,
      type: 'gate.overridden',
      actor: 'user',
      runId,
      payload: {
        blockingItemIds: overridden,
        relayedBy: override?.relayedBy ?? null,
        userInstruction: override?.userInstruction ?? null,
      },
    });

  const existing = await existingItemIds(trx, idea.id);
  const lines = [
    out.initial_thought,
    ...out.what_changed,
    ...out.rejected,
    ...out.uncertain,
    ...out.conclusions,
    ...out.evidence,
    ...out.open_questions,
  ];
  for (const ref of [...lines.flatMap((l) => l.refs), ...out.tangents.map((t) => t.item)])
    if (!existing.has(ref)) throw invalid(`Synthesis refers to an unknown item "${ref}".`);

  // Retire the previous synthesis and any of its conclusions the user has not ruled on.
  const previous = await trx
    .selectFrom('syntheses')
    .select(['item_id', 'version'])
    .where('idea_id', '=', idea.id)
    .orderBy('version', 'desc')
    .executeTakeFirst();

  const synthesisItem = await createItem(trx, {
    idea,
    kind: 'synthesis',
    origin: 'agent',
    text: out.statement,
    runId,
    via: 'synthesize',
  });

  if (previous) {
    const stale = await trx
      .selectFrom('relations')
      .innerJoin('reasoning_items', 'reasoning_items.id', 'relations.from_item_id')
      .select('reasoning_items.id')
      .where('relations.to_item_id', '=', previous.item_id)
      .where('relations.type', '=', 'synthesized_into')
      .where('reasoning_items.kind', '=', 'conclusion')
      .where('reasoning_items.status', '=', 'open')
      .execute();
    const previousItem = await trx
      .selectFrom('reasoning_items')
      .select('status')
      .where('id', '=', previous.item_id)
      .executeTakeFirstOrThrow();
    // Defensive: never let an already-retired record wedge the next version.
    const toRetire = previousItem.status === 'superseded' ? [] : [previous.item_id];
    for (const id of [...toRetire, ...stale.map((s) => s.id)])
      await recordDecision(trx, {
        itemId: id,
        type: 'supersede',
        author: 'agent',
        rationale: `Superseded by synthesis v${previous.version + 1}.`,
        relatedItemIds: [synthesisItem.id],
        runId,
      });
    await createRelation(trx, {
      ideaId: idea.id,
      fromItemId: synthesisItem.id,
      toItemId: previous.item_id,
      type: 'supersedes',
      author: 'agent',
      runId,
    });
  }

  const conclusions: SynthesisBodyDto['conclusions'] = [];
  for (const c of out.conclusions) {
    const item = await createItem(trx, {
      idea,
      kind: 'conclusion',
      origin: 'agent',
      text: c.text,
      runId,
      runKey: c.key,
      via: 'synthesize',
    });
    for (const ref of new Set(c.refs))
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: ref,
        toItemId: item.id,
        type: 'synthesized_into',
        author: 'agent',
        runId,
      });
    await createRelation(trx, {
      ideaId: idea.id,
      fromItemId: item.id,
      toItemId: synthesisItem.id,
      type: 'synthesized_into',
      author: 'agent',
      runId,
    });
    conclusions.push({ text: c.text, refs: c.refs, itemId: item.id, confidence: c.confidence });
  }
  if (conclusions.length === 0)
    for (const ref of new Set(out.initial_thought.refs))
      await createRelation(trx, {
        ideaId: idea.id,
        fromItemId: ref,
        toItemId: synthesisItem.id,
        type: 'synthesized_into',
        author: 'agent',
        runId,
      });

  // Step 8 - tangent archive. Only items the user has not ruled on are set aside.
  const archivedTangents: SynthesisBodyDto['archivedTangents'] = [];
  for (const t of out.tangents) {
    const item = await trx
      .selectFrom('reasoning_items')
      .select(['status', 'kind'])
      .where('id', '=', t.item)
      .executeTakeFirstOrThrow();
    if (item.status !== 'open' || item.kind === 'original_idea') continue;
    await recordDecision(trx, {
      itemId: t.item,
      type: 'mark_tangent',
      author: 'agent',
      rationale: t.reason,
      runId,
    });
    archivedTangents.push({ itemId: t.item, reason: t.reason });
  }

  const body: SynthesisBodyDto = {
    statement: out.statement,
    initialThought: out.initial_thought,
    whatChanged: out.what_changed,
    rejected: out.rejected,
    uncertain: out.uncertain,
    conclusions,
    evidence: out.evidence,
    openQuestions: out.open_questions,
    archivedTangents,
  };
  const version = (previous?.version ?? 0) + 1;
  await trx
    .insertInto('syntheses')
    .values({
      id: newId('syn'),
      idea_id: idea.id,
      item_id: synthesisItem.id,
      version,
      run_id: runId,
      body_json: JSON.stringify(body),
      created_at: nowIso(),
    })
    .execute();
  await logEvent(trx, {
    ideaId: idea.id,
    itemId: synthesisItem.id,
    type: 'synthesis.created',
    actor: 'agent',
    runId,
    payload: {
      version,
      conclusions: conclusions.length,
      archivedTangents: archivedTangents.length,
    },
  });
  await setStage(trx, idea.id, idea.stage, 'synthesized');
  return {
    synthesisItemId: synthesisItem.id,
    version,
    conclusionItemIds: conclusions.map((c) => c.itemId),
    archivedTangentIds: archivedTangents.map((t) => t.itemId),
  };
}
