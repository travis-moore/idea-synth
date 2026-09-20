/**
 * The eight-stage workflow.
 *
 *   runAnalysis  = Steps 2-5 (extract -> explore -> epistemic -> adversarial)
 *   [review gate: the user works through the items]
 *   runSynthesis = Steps 6-8 (builder -> synthesis + tangent archive)
 *
 * Each pass is one provider call, validated against its schema, then applied in ONE
 * transaction together with its `analysis_runs` row. A pass either lands completely or
 * leaves nothing behind except a `failed` run recording why.
 */
import type { Transaction } from 'kysely';
import { ZodError } from 'zod';
import { analysisRequests } from '../ai/passes';
import type { StructuredRequest } from '../ai/provider';
import type {
  AdversarialOutput,
  BuilderOutput,
  EpistemicOutput,
  ExploreOutput,
  ExtractOutput,
  NewItemOutput,
  SynthesizeOutput,
} from '../ai/schemas';
import type { SynthesisBodyDto } from '../api-types';
import type { Database, IdeasTable } from '../db/schema';
import { conflict, DomainError, invalid, upstream } from '../domain/errors';
import { newId } from '../domain/ids';
import { evaluateReviewGate } from '../domain/rules';
import {
  ANALYSIS_PASS_ORDER,
  EXTRACTABLE_KINDS,
  type ItemKind,
  type Origin,
  type Pass,
} from '../domain/vocabulary';
import type { AppContext } from './context';
import { setStage } from './ideas';
import { buildSnapshot } from './queries';
import {
  createItem,
  createRelation,
  logEvent,
  nowIso,
  recordAssessment,
  recordDecision,
  requireIdea,
} from './store';

type Trx = Transaction<Database>;

/** What each pass is allowed to add. A model that strays outside fails validation. */
const ALLOWED_KINDS: Record<
  'extract' | 'explore' | 'epistemic' | 'adversarial' | 'builder',
  readonly ItemKind[]
> = {
  extract: EXTRACTABLE_KINDS,
  explore: ['implication', 'extension', 'question', 'analogy', 'hypothesis'],
  epistemic: ['correction'],
  adversarial: ['objection', 'question', 'assumption', 'uncertainty'],
  builder: [
    'hypothesis',
    'example',
    'test',
    'distinction',
    'question',
    'implication',
    'extension',
    'inference',
  ],
};

// One pipeline run per idea at a time. Single-process by design (see ADR 0001).
const running = new Set<string>();
async function withIdeaLock<T>(ideaId: string, fn: () => Promise<T>): Promise<T> {
  if (running.has(ideaId)) throw conflict('A reasoning run is already in progress for this idea.');
  running.add(ideaId);
  try {
    return await fn();
  } finally {
    running.delete(ideaId);
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof ZodError)
    return `Model output failed validation: ${error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Call the provider, validate, and apply the result atomically. Exported for the
 * discussion and tutor services, which are passes too.
 */
export async function executePass<T, R>(
  ctx: AppContext,
  ideaId: string,
  request: StructuredRequest<T>,
  apply: (trx: Trx, output: T, runId: string) => Promise<R>,
): Promise<R> {
  const startedAt = nowIso();
  const base = {
    idea_id: ideaId,
    pass: request.pass,
    provider: ctx.provider.name,
    model: ctx.provider.model,
    prompt_version: request.promptVersion,
    input_json: JSON.stringify({ task: request.task, input: request.input }),
    started_at: startedAt,
  };
  try {
    const raw = await ctx.provider.generate(request);
    const output = request.schema.parse(raw);
    return await ctx.db.transaction().execute(async (trx) => {
      const runId = newId('run');
      await trx
        .insertInto('analysis_runs')
        .values({
          ...base,
          id: runId,
          status: 'completed',
          output_json: JSON.stringify(output),
          error: null,
          finished_at: nowIso(),
        })
        .execute();
      await logEvent(trx, {
        ideaId,
        type: 'run.completed',
        actor: 'system',
        runId,
        payload: { pass: request.pass, task: request.task, provider: ctx.provider.name },
      });
      return apply(trx, output, runId);
    });
  } catch (error) {
    const message = describeFailure(error);
    const runId = newId('run');
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('analysis_runs')
        .values({
          ...base,
          id: runId,
          status: 'failed',
          output_json: null,
          error: message,
          finished_at: nowIso(),
        })
        .execute();
      await logEvent(trx, {
        ideaId,
        type: 'run.failed',
        actor: 'system',
        runId,
        payload: { pass: request.pass, task: request.task, error: message },
      });
    });
    if (error instanceof DomainError && error.code !== 'invalid') throw error;
    throw upstream(`The ${request.pass} pass failed and nothing was changed. ${message}`);
  }
}

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
async function applyNewItems(
  trx: Trx,
  idea: IdeasTable,
  runId: string,
  pass: keyof typeof ALLOWED_KINDS,
  items: Array<NewItemOutput & { source_quotes?: string[] }>,
  origin: Origin,
): Promise<Map<string, string>> {
  const existing = await existingItemIds(trx, idea.id);
  const keyToId = new Map<string, string>();
  for (const item of items) {
    if (!ALLOWED_KINDS[pass].includes(item.kind))
      throw invalid(`The ${pass} pass may not create items of kind "${item.kind}".`);
    if (keyToId.has(item.key)) throw invalid(`Duplicate item key "${item.key}" in model output.`);
    if (pass !== 'extract' && item.links.length === 0)
      throw invalid(`Item "${item.key}" is not linked to anything it arose from.`);
    const row = await createItem(trx, {
      idea,
      kind: item.kind,
      origin,
      text: item.text,
      status: item.needs_user && !item.is_tangent ? 'needs_user' : 'open',
      attentionReason: item.attention_reason ?? null,
      runId,
      runKey: item.key,
      sourceQuotes: item.source_quotes ?? [],
      via: pass,
    });
    keyToId.set(item.key, row.id);
  }

  const resolve = resolver(existing, keyToId);
  const root = await trx
    .selectFrom('reasoning_items')
    .select('id')
    .where('idea_id', '=', idea.id)
    .where('kind', '=', 'original_idea')
    .executeTakeFirstOrThrow();

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
  return keyToId;
}

async function applyFlags(
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

async function applyEpistemic(trx: Trx, idea: IdeasTable, runId: string, out: EpistemicOutput) {
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
  const keyToId = await applyNewItems(trx, idea, runId, 'epistemic', out.corrections, 'agent');
  const resolve = resolver(existing, keyToId);
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
}

async function completedPasses(ctx: AppContext, ideaId: string): Promise<Set<Pass>> {
  const rows = await ctx.db
    .selectFrom('analysis_runs')
    .select('pass')
    .where('idea_id', '=', ideaId)
    .where('status', '=', 'completed')
    .execute();
  return new Set(rows.map((r) => r.pass));
}

/**
 * Steps 2-5. Resumable: if an earlier attempt failed part-way, passes that already
 * completed are not repeated.
 */
export async function runAnalysis(ctx: AppContext, ideaId: string): Promise<void> {
  await withIdeaLock(ideaId, async () => {
    const idea = await requireIdea(ctx.db, ideaId);
    if (idea.stage !== 'captured' && idea.stage !== 'guided')
      throw conflict('This idea has already been analysed. Continue with the review.');
    const done = await completedPasses(ctx, ideaId);

    for (const pass of ANALYSIS_PASS_ORDER) {
      if (done.has(pass)) continue;
      const snapshot = await buildSnapshot(ctx.db, ideaId);
      switch (pass) {
        case 'extract':
          await executePass(
            ctx,
            ideaId,
            analysisRequests.extract(snapshot),
            (trx, out: ExtractOutput, runId) =>
              applyNewItems(trx, idea, runId, 'extract', out.items, 'extracted_from_user'),
          );
          break;
        case 'explore':
          await executePass(
            ctx,
            ideaId,
            analysisRequests.explore(snapshot),
            (trx, out: ExploreOutput, runId) =>
              applyNewItems(trx, idea, runId, 'explore', out.items, 'agent'),
          );
          break;
        case 'epistemic':
          await executePass(
            ctx,
            ideaId,
            analysisRequests.epistemic(snapshot),
            (trx, out: EpistemicOutput, runId) => applyEpistemic(trx, idea, runId, out),
          );
          break;
        case 'adversarial':
          await executePass(
            ctx,
            ideaId,
            analysisRequests.adversarial(snapshot),
            async (trx, out: AdversarialOutput, runId) => {
              await applyNewItems(trx, idea, runId, 'adversarial', out.items, 'agent');
              await applyFlags(trx, idea.id, runId, out.flags);
            },
          );
          break;
      }
    }
    await ctx.db.transaction().execute((trx) => setStage(trx, ideaId, idea.stage, 'in_review'));
  });
}

async function applySynthesis(
  trx: Trx,
  idea: IdeasTable,
  runId: string,
  out: SynthesizeOutput,
): Promise<void> {
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
    for (const id of [previous.item_id, ...stale.map((s) => s.id)])
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
}

/**
 * Steps 6-8. Refuses to run while items still need the user, unless `force` is set, in
 * which case the override is itself recorded in the history.
 */
export async function runSynthesis(
  ctx: AppContext,
  ideaId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  await withIdeaLock(ideaId, async () => {
    const idea = await requireIdea(ctx.db, ideaId);
    if (idea.stage !== 'in_review' && idea.stage !== 'synthesized')
      throw conflict('Run the analysis (Steps 2-5) before building a synthesis.');
    const items = await ctx.db
      .selectFrom('reasoning_items')
      .select(['id', 'status', 'kind'])
      .where('idea_id', '=', ideaId)
      .execute();
    const gate = evaluateReviewGate(items);
    if (!gate.canProceed) {
      if (!options.force)
        throw conflict(
          `${gate.blockingItemIds.length} item(s) still need your input. Review them first, or proceed anyway.`,
        );
      await logEvent(ctx.db, {
        ideaId,
        type: 'gate.overridden',
        actor: 'user',
        payload: { blockingItemIds: gate.blockingItemIds },
      });
    }

    await executePass(
      ctx,
      ideaId,
      analysisRequests.builder(await buildSnapshot(ctx.db, ideaId)),
      (trx, out: BuilderOutput, runId) =>
        applyNewItems(trx, idea, runId, 'builder', out.items, 'agent'),
    );
    await executePass(
      ctx,
      ideaId,
      analysisRequests.synthesize(await buildSnapshot(ctx.db, ideaId)),
      (trx, out: SynthesizeOutput, runId) => applySynthesis(trx, idea, runId, out),
    );
  });
}
