/**
 * The agent API: everything an external reasoning agent (Claude Code or Codex in a VS
 * Code panel) may do to Idea Synth, as named commands with JSON in and JSON out.
 *
 * - It is a thin layer over the SAME services the web UI and workers use. It contains no
 *   reasoning rules of its own and never touches SQLite directly.
 * - The agent does the reasoning itself, in its own conversation. `passes.next` and
 *   `guided.next` hand it a contract (instructions + JSON Schema + the input version it
 *   was read at); `passes.submit` and `guided.submit` validate and apply what it produced,
 *   through exactly the path provider output takes. No second model is involved.
 * - Every mutating command carries `meta`: a request id (idempotent retries), the agent's
 *   identity and session, and, for anything that is the user's call, the user's own words.
 *
 * Each command is `{ description, mutating, input (zod) , run }`, which is deliberately
 * the shape of an MCP tool: a future MCP adapter can expose this registry as-is.
 */
import { z } from 'zod';
import type { Db } from '../db/schema';
import { forbidden, invalid } from '../domain/errors';
import { PREMISE_STANCES } from '../domain/scaffolding';
import { authorSchema, decisionTypeSchema, itemKindSchema } from '../domain/vocabulary';
import type { GateOverride } from '../services/apply';
import {
  assertNoUnansweredPremise,
  commitGuidedTask,
  createGuidedSession,
  findSessionByIdea,
  getGuidedSession,
  prepareGuidedTask,
  recordAnswer,
  recordPremiseResponse,
} from '../services/guided';
import { captureIdea } from '../services/ideas';
import {
  attachEvidence,
  branchItem,
  decide,
  mergeItems,
  postContribution,
  promoteTangent,
  reviseItem,
  splitItem,
  supersedeItem,
} from '../services/items';
import { applyOperation, CONTRACT_VERSION, type OperationMeta } from '../services/operation';
import {
  commitWorkflowPass,
  nextWorkflowPass,
  preparePass,
  WORKFLOW_PASSES,
  type Producer,
} from '../services/pipeline';
import {
  getGraph,
  getIdea,
  getItemDetail,
  getSynthesis,
  listIdeaEvents,
  listIdeas,
  listInbox,
  listRuns,
} from '../services/queries';
import { requireItem } from '../services/store';

const text = z.string().min(1).max(50_000);

/** Who is calling. Required on every mutating command. */
export const metaSchema = z.object({
  requestId: z
    .string()
    .min(8)
    .max(200)
    .describe(
      'Idempotency key. Reuse the SAME id when retrying the SAME request; use a new one otherwise.',
    ),
  agent: z.string().min(1).max(80).describe('Your agent name, e.g. "claude-code" or "codex".'),
  sessionId: z
    .string()
    .max(200)
    .optional()
    .describe('Your own conversation/session id, if you have one.'),
  model: z
    .string()
    .max(120)
    .optional()
    .describe('The model you are running on, as far as you know. Stored as a claim.'),
  userInstruction: z
    .string()
    .max(5_000)
    .optional()
    .describe(
      "The user's own words authorising this. REQUIRED for anything that is the user's call (decisions, split/merge/supersede, promote, gate override). Quote the user; never paraphrase or infer consent.",
    ),
});
type Meta = z.infer<typeof metaSchema>;

const toOperationMeta = (meta: Meta, inputVersion?: number): OperationMeta => ({
  requestId: meta.requestId,
  client: 'cli',
  clientSession: meta.sessionId,
  executedBy: 'agent',
  agentName: meta.agent,
  agentModel: meta.model,
  userInstruction: meta.userInstruction,
  inputVersion,
});

/** What was asked, without the envelope: the basis of the request fingerprint. */
function payloadOf(input: object): unknown {
  const { meta: _meta, ...rest } = input as { meta?: unknown };
  return rest;
}

const producerOf = (meta: Meta): Producer => ({
  name: meta.agent,
  model: meta.model ?? 'unreported',
  modelSource: 'self_reported',
  authMode: 'external_session',
});

const inputVersion = z
  .number()
  .int()
  .nonnegative()
  .describe('The idea inputVersion your work is based on (from ideas.context / passes.next).');
const author = authorSchema.describe(
  '"user" = the user\'s exact words, relayed verbatim. "agent" = words you wrote, even if the user asked for them.',
);
const overrideSchema = z
  .object({ blockingItemIds: z.array(z.string()).min(1) })
  .describe(
    'The user chose to proceed past exactly these needs-user items. Requires meta.userInstruction.',
  );

export interface CommandContext {
  db: Db;
}

export interface Command<S extends z.ZodType = z.ZodType> {
  description: string;
  mutating: boolean;
  input: S;
  run(ctx: CommandContext, input: z.infer<S>): Promise<unknown>;
}

const command = <S extends z.ZodType>(c: Command<S>): Command<S> => c;

function gateOverride(
  meta: Meta,
  override: z.infer<typeof overrideSchema> | undefined,
): GateOverride | undefined {
  if (!override) return undefined;
  if (!meta.userInstruction?.trim())
    throw forbidden(
      'Only the user can override the review gate. Pass their own words as meta.userInstruction; consent must never be inferred.',
    );
  return { ...override, relayedBy: meta.agent, userInstruction: meta.userInstruction };
}

const schemaOf = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' });

export const commands = {
  // -------------------------------------------------------------------------------------
  // Reading: discover ideas and resume from stored history, not from a chat transcript
  // -------------------------------------------------------------------------------------
  'ideas.list': command({
    description: 'List ideas with their stage, counts and input version.',
    mutating: false,
    input: z.object({}),
    run: ({ db }) => listIdeas(db),
  }),

  'ideas.context': command({
    description:
      'Focused context for working on one idea: original text, stage, inputVersion, review gate, what to do next, all items (compact) and relations, the latest synthesis, and any guided session. Pass focusItemId for one item in full (discussion, decisions, revisions, evidence, sources).',
    mutating: false,
    input: z.object({ ideaId: z.string(), focusItemId: z.string().optional() }),
    run: async ({ db }, input) => {
      const [idea, graph, synthesis, session, inbox] = await Promise.all([
        getIdea(db, input.ideaId),
        getGraph(db, input.ideaId),
        getSynthesis(db, input.ideaId),
        findSessionByIdea(db, input.ideaId),
        listInbox(db, input.ideaId),
      ]);
      const nextPass = await nextWorkflowPass(db, input.ideaId);
      const analysing = idea.stage === 'captured' || idea.stage === 'guided';
      const guided =
        session && session.status === 'active' ? await getGuidedSession(db, session.id) : null;
      return {
        contractVersion: CONTRACT_VERSION,
        idea: {
          id: idea.id,
          title: idea.title,
          stage: idea.stage,
          source: idea.source,
          originalText: idea.originalText,
          promotedFrom: idea.promotedFrom,
        },
        inputVersion: idea.revision,
        gate: idea.gate,
        needsUser: inbox.map((i) => ({
          id: i.id,
          kind: i.kind,
          reason: i.attentionReason,
          text: i.text,
        })),
        next: guided
          ? {
              kind: 'guided',
              pendingTask: guided.pendingTask,
              sessionId: guided.id,
              hint: 'Use guided.get / guided.next.',
            }
          : analysing
            ? {
                kind: 'pass',
                pass: nextPass,
                hint: 'Call passes.next, reason, then passes.submit.',
              }
            : idea.gate.canProceed
              ? {
                  kind: 'pass',
                  pass: nextPass,
                  hint: 'The gate is clear. Ask the user whether to build the synthesis, then passes.next.',
                }
              : {
                  kind: 'review',
                  hint: 'Discuss the needs-user items WITH THE USER and record THEIR decisions (items.decide). Do not decide for them.',
                },
        items: graph.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          origin: n.origin,
          status: n.status,
          verdict: n.epistemicVerdict,
          attentionReason: n.attentionReason,
          messages: n.messageCount,
          falsePremiseProductive: n.productiveDescendantIds.length > 0,
          text: n.text,
        })),
        relations: graph.edges.map((e) => ({ from: e.fromItemId, type: e.type, to: e.toItemId })),
        synthesis: synthesis
          ? {
              version: synthesis.version,
              statement: synthesis.body.statement,
              conclusions: synthesis.body.conclusions,
            }
          : null,
        focus: input.focusItemId ? await getItemDetail(db, input.focusItemId) : null,
      };
    },
  }),

  'ideas.graph': command({
    description: 'All nodes and edges of an idea, in full.',
    mutating: false,
    input: z.object({ ideaId: z.string() }),
    run: ({ db }, input) => getGraph(db, input.ideaId),
  }),

  'ideas.history': command({
    description: 'Audit log and reasoning runs of an idea (most recent last).',
    mutating: false,
    input: z.object({ ideaId: z.string(), limit: z.number().int().min(1).max(500).default(60) }),
    run: async ({ db }, input) => ({
      runs: await listRuns(db, input.ideaId),
      events: (await listIdeaEvents(db, input.ideaId)).slice(-input.limit),
    }),
  }),

  'items.get': command({
    description:
      'One item in full: text, origin, status, source quotes, revisions, discussion, decisions, assessments, evidence, links and history.',
    mutating: false,
    input: z.object({ itemId: z.string() }),
    run: ({ db }, input) => getItemDetail(db, input.itemId),
  }),

  'synthesis.get': command({
    description:
      'The latest (or a given version of the) synthesis, with every line traced to item ids.',
    mutating: false,
    input: z.object({ ideaId: z.string(), version: z.number().int().positive().optional() }),
    run: ({ db }, input) => getSynthesis(db, input.ideaId, input.version),
  }),

  // -------------------------------------------------------------------------------------
  // Capturing and discussing
  // -------------------------------------------------------------------------------------
  'ideas.capture': command({
    description:
      'Step 1. Capture an idea. With author "user", text MUST be the user\'s exact words (no tidying, no summarising): it becomes permanent, immutable provenance. With author "agent" it is recorded as yours.',
    mutating: true,
    input: z.object({ meta: metaSchema, text, author, title: z.string().max(200).optional() }),
    run: async ({ db }, input) => {
      const outcome = await applyOperation(
        db,
        {
          name: 'ideas.capture',
          ideaId: null,
          meta: toOperationMeta(input.meta),
          input: payloadOf(input),
        },
        async (trx) => {
          const idea = await captureIdea(trx, {
            text: input.text,
            title: input.title,
            rootOrigin: input.author === 'agent' ? 'agent' : 'user',
          });
          return { ideaId: idea.id };
        },
      );
      return { ...outcome.result, inputVersion: outcome.inputVersion, replayed: outcome.replayed };
    },
  }),

  'items.discuss': command({
    description:
      'Append ONE contribution to an item\'s discussion thread. Post the user\'s words as author "user" (verbatim) and your own as author "agent", as separate calls. Nothing else is inferred from a message.',
    mutating: true,
    input: z.object({ meta: metaSchema, itemId: z.string(), author, body: text }),
    run: ({ db }, input) =>
      itemOp(db, 'items.discuss', input.itemId, input, undefined, (trx) =>
        postContribution(trx, input.itemId, { author: input.author, body: input.body }),
      ),
  }),

  // -------------------------------------------------------------------------------------
  // Reasoning passes: YOU reason, the application validates and stores
  // -------------------------------------------------------------------------------------
  'passes.next': command({
    description:
      'Get the contract for the next reasoning pass of an idea: which pass it is, the instructions, the idea as input, the JSON Schema your output must satisfy, and the inputVersion to echo back. Read-only. For builder/synthesize the review gate is enforced (pass `override` only if the user explicitly chose to proceed).',
    mutating: false,
    input: z.object({ ideaId: z.string(), override: overrideSchema.optional() }),
    run: async ({ db }, input) => {
      await assertNoUnansweredPremise(db, input.ideaId); // read-only: this command writes nothing
      const pass = await nextWorkflowPass(db, input.ideaId);
      const prepared = await preparePass(db, input.ideaId, pass, {
        override: input.override ? { ...input.override } : undefined,
      });
      return {
        contractVersion: CONTRACT_VERSION,
        ideaId: input.ideaId,
        pass,
        inputVersion: prepared.inputVersion,
        promptVersion: prepared.request.promptVersion,
        instructions: prepared.request.system,
        input: prepared.request.prompt,
        outputSchema: schemaOf(prepared.request.schema),
        rules: [
          'Reference existing items by their id; refer to items you create in the same output by their key.',
          'Submit with passes.submit, echoing inputVersion. If the idea changed meanwhile you get a stale_input conflict: call passes.next again and redo the reasoning.',
          "Everything you submit is recorded as agent-originated (extractions only count as the user's when a quote is found in their text).",
        ],
      };
    },
  }),

  'passes.submit': command({
    description:
      'Submit the output YOU produced for a pass. It is validated against the same schema and rules as provider output and applied atomically, or refused whole (invalid, not the next pass, stale input, review gate).',
    mutating: true,
    input: z.object({
      meta: metaSchema,
      ideaId: z.string(),
      pass: z.enum(WORKFLOW_PASSES as [string, ...string[]]),
      inputVersion,
      output: z.unknown(),
      override: overrideSchema.optional(),
    }),
    run: async ({ db }, input) => {
      const pass = input.pass as (typeof WORKFLOW_PASSES)[number];
      const committed = await commitWorkflowPass(
        db,
        { ideaId: input.ideaId, pass, inputVersion: input.inputVersion },
        input.output,
        producerOf(input.meta),
        toOperationMeta(input.meta),
        { override: gateOverride(input.meta, input.override) },
      );
      return {
        pass,
        applied: committed.result,
        runId: committed.runId,
        replayed: committed.replayed,
        inputVersion: committed.inputVersion,
        next: await nextWorkflowPass(db, input.ideaId),
      };
    },
  }),

  // -------------------------------------------------------------------------------------
  // The user's decisions, relayed (never made) by the agent
  // -------------------------------------------------------------------------------------
  'items.decide': command({
    description:
      "Record the USER's decision on an item: accept, qualify (needs `qualification`), reject, reopen, mark_tangent, flag_needs_user. Requires meta.userInstruction with the user's own words. You may not decide on the user's behalf.",
    mutating: true,
    input: z.object({
      meta: metaSchema,
      itemId: z.string(),
      decision: decisionTypeSchema,
      rationale: z.string().max(5_000).optional(),
      qualification: z.string().max(5_000).optional(),
      inputVersion: inputVersion.optional(),
    }),
    run: ({ db }, input) =>
      itemOp(db, 'items.decide', input.itemId, input, input.inputVersion, async (trx) => ({
        status: await decide(trx, input.itemId, input),
      })),
  }),

  'items.split': command({
    description:
      'Split an item into parts (the user\'s decision; needs meta.userInstruction). Give each part its true author: parts you wrote are "agent" even though the user approved the split.',
    mutating: true,
    input: z.object({
      meta: metaSchema,
      itemId: z.string(),
      children: z
        .array(z.object({ text, kind: itemKindSchema.optional(), author }))
        .min(2)
        .max(12),
      rationale: z.string().max(5_000).optional(),
      inputVersion: inputVersion.optional(),
    }),
    run: ({ db }, input) =>
      itemOp(db, 'items.split', input.itemId, input, input.inputVersion, async (trx) => ({
        childIds: (await splitItem(trx, input.itemId, input)).map((c) => c.id),
      })),
  }),

  'items.branch': command({
    description:
      'Grow a new item out of an existing one (new hypothesis, correction, research question; or a tangent with asTangent). The parent is unchanged, so no user decision is needed; author it truthfully.',
    mutating: true,
    input: z.object({
      meta: metaSchema,
      itemId: z.string(),
      text,
      author,
      kind: itemKindSchema.optional(),
      asTangent: z.boolean().optional(),
    }),
    run: ({ db }, input) =>
      itemOp(db, 'items.branch', input.itemId, input, undefined, async (trx) => ({
        itemId: (await branchItem(trx, input.itemId, input)).id,
      })),
  }),

  'items.merge': command({
    description:
      "Merge items into a new one (the user's decision; needs meta.userInstruction). `author` is who wrote the merged text.",
    mutating: true,
    input: z.object({
      meta: metaSchema,
      itemIds: z.array(z.string()).min(2),
      text,
      author,
      kind: itemKindSchema.optional(),
      rationale: z.string().max(5_000).optional(),
    }),
    run: ({ db }, input) =>
      itemOp(db, 'items.merge', input.itemIds[0]!, input, undefined, async (trx) => ({
        itemId: (await mergeItems(trx, input)).id,
      })),
  }),

  'items.supersede': command({
    description:
      "Replace an item with a substantively new formulation (the user's decision; needs meta.userInstruction). The old item stays. `author` is who wrote the new text.",
    mutating: true,
    input: z.object({
      meta: metaSchema,
      itemId: z.string(),
      text,
      author,
      kind: itemKindSchema.optional(),
      reason: z.string().max(5_000).optional(),
      causedByItemId: z.string().optional(),
    }),
    run: ({ db }, input) =>
      itemOp(db, 'items.supersede', input.itemId, input, undefined, async (trx) => ({
        itemId: (await supersedeItem(trx, input.itemId, input)).id,
      })),
  }),

  'items.revise': command({
    description:
      'Reword an item (small refinement; history is kept). As author "agent" you may only reword items you originated; to change the user\'s thought, propose a branch or a superseding item instead.',
    mutating: true,
    input: z.object({
      meta: metaSchema,
      itemId: z.string(),
      text,
      author,
      reason: z.string().max(5_000).optional(),
      causedByItemId: z.string().optional(),
    }),
    run: ({ db }, input) =>
      itemOp(db, 'items.revise', input.itemId, input, undefined, async (trx) => ({
        revision: await reviseItem(trx, input.itemId, input),
      })),
  }),

  'items.evidence': command({
    description:
      'Attach evidence for or against an item. Only cite sources that really exist; say who found it via `author`.',
    mutating: true,
    input: z.object({
      meta: metaSchema,
      itemId: z.string(),
      text,
      author,
      stance: z.enum(['for', 'against']),
      sourceTitle: z.string().min(1).max(500),
      url: z.string().url().optional(),
      excerpt: z.string().max(5_000).optional(),
    }),
    run: ({ db }, input) =>
      itemOp(db, 'items.evidence', input.itemId, input, undefined, async (trx) => ({
        itemId: (await attachEvidence(trx, input.itemId, input)).id,
      })),
  }),

  'items.promote': command({
    description:
      "Promote a tangent to its own idea (the user's decision; needs meta.userInstruction). Without `framing` the new idea keeps the tangent's authorship.",
    mutating: true,
    input: z
      .object({
        meta: metaSchema,
        itemId: z.string(),
        framing: z.string().max(50_000).optional(),
        framingAuthor: author.optional(),
      })
      .refine((v) => !v.framing?.trim() || v.framingAuthor !== undefined, {
        message: 'framingAuthor is required with framing: "user" only for their exact words',
        path: ['framingAuthor'],
      }),
    run: ({ db }, input) =>
      itemOp(db, 'items.promote', input.itemId, input, undefined, async (trx) => ({
        ideaId: (await promoteTangent(trx, input.itemId, input)).id,
      })),
  }),

  // -------------------------------------------------------------------------------------
  // Guided idea development: the scaffolding level is chosen by code, not by you
  // -------------------------------------------------------------------------------------
  'guided.start': command({
    description:
      "Start guided development of a hypothesis. `hypothesis` must be the user's exact words. Then call guided.next to get your first tutoring task.",
    mutating: true,
    input: z.object({ meta: metaSchema, hypothesis: text }),
    run: async ({ db }, input) => {
      const outcome = await applyOperation(
        db,
        {
          name: 'guided.start',
          ideaId: null,
          meta: toOperationMeta(input.meta),
          input: payloadOf(input),
        },
        (trx) => createGuidedSession(trx, { hypothesis: input.hypothesis, author: 'user' }),
      );
      return { ...outcome.result, inputVersion: outcome.inputVersion, replayed: outcome.replayed };
    },
  }),

  'guided.get': command({
    description:
      'A guided session: transcript with scaffolding levels, what it is waiting for (pendingTask) and inputVersion.',
    mutating: false,
    input: z.object({ sessionId: z.string() }),
    run: ({ db }, input) => getGuidedSession(db, input.sessionId),
  }),

  'guided.answer': command({
    description:
      "Store the USER's answer to the tutor's question, exactly as they said it (it is persisted before anything is inferred from it). Then call guided.next to assess it.",
    mutating: true,
    input: z.object({ meta: metaSchema, sessionId: z.string(), body: text }),
    run: async ({ db }, input) => {
      const session = await getGuidedSession(db, input.sessionId);
      const outcome = await applyOperation(
        db,
        {
          name: 'guided.answer',
          ideaId: session.ideaId,
          meta: toOperationMeta(input.meta),
          input: payloadOf(input),
        },
        async (trx) => ({
          stepId: await recordAnswer(trx, input.sessionId, input.body),
        }),
      );
      return { ...outcome.result, inputVersion: outcome.inputVersion, replayed: outcome.replayed };
    },
  }),

  'guided.next': command({
    description:
      'Get the tutoring task the session is waiting for: "assessment" (judge the stored answer) or "move" (produce the next tutor move AT THE LEVEL GIVEN; you do not choose the level). Returns instructions, input, output JSON Schema and inputVersion. Read-only.',
    mutating: false,
    input: z.object({ sessionId: z.string() }),
    run: async ({ db }, input) => {
      const prepared = await prepareGuidedTask(db, input.sessionId);
      return {
        contractVersion: CONTRACT_VERSION,
        sessionId: prepared.sessionId,
        task: prepared.task,
        inputVersion: prepared.inputVersion,
        promptVersion: prepared.request.promptVersion,
        instructions: prepared.request.system,
        input: prepared.request.prompt,
        outputSchema: schemaOf(prepared.request.schema),
      };
    },
  }),

  'guided.submit': command({
    description:
      'Submit the assessment or move YOU produced for guided.next. Validated and applied atomically; stale or duplicate submissions are refused.',
    mutating: true,
    input: z.object({
      meta: metaSchema,
      sessionId: z.string(),
      task: z.enum(['assessment', 'move']),
      inputVersion,
      output: z.unknown(),
    }),
    run: async ({ db }, input) => {
      const session = await getGuidedSession(db, input.sessionId);
      const committed = await commitGuidedTask(
        db,
        {
          sessionId: input.sessionId,
          ideaId: session.ideaId,
          task: input.task,
          inputVersion: input.inputVersion,
        },
        input.output,
        producerOf(input.meta),
        toOperationMeta(input.meta),
      );
      const after = await getGuidedSession(db, input.sessionId);
      return {
        applied: committed.result,
        replayed: committed.replayed,
        inputVersion: committed.inputVersion,
        pendingTask: after.pendingTask,
        level: after.level,
      };
    },
  }),

  'guided.premise': command({
    description:
      "Record the USER's response to an agent-supplied (level 5) premise: accept, reject, or modify (body = the user's own wording). Needs meta.userInstruction. Accepting never makes the premise the user's idea.",
    mutating: true,
    input: z.object({
      meta: metaSchema,
      sessionId: z.string(),
      stance: z.enum(PREMISE_STANCES),
      body: z.string().max(50_000).optional(),
    }),
    run: async ({ db }, input) => {
      const session = await getGuidedSession(db, input.sessionId);
      if (input.stance === 'modify' && !input.meta.userInstruction?.trim())
        throw invalid("Pass the user's own words as meta.userInstruction.");
      const outcome = await applyOperation(
        db,
        {
          name: 'guided.premise',
          ideaId: session.ideaId,
          meta: toOperationMeta(input.meta),
          input: payloadOf(input),
        },
        async (trx) => {
          await recordPremiseResponse(trx, input.sessionId, input);
          return { ok: true };
        },
      );
      return { ...outcome.result, inputVersion: outcome.inputVersion, replayed: outcome.replayed };
    },
  }),

  'gate.check': command({
    description:
      'Check the human review gate for an idea: which items still need the user before a synthesis may be built.',
    mutating: false,
    input: z.object({ ideaId: z.string() }),
    run: async ({ db }, input) => {
      const idea = await getIdea(db, input.ideaId);
      const inbox = await listInbox(db, input.ideaId);
      return {
        canProceed: idea.gate.canProceed,
        blocking: inbox.map((i) => ({
          id: i.id,
          kind: i.kind,
          reason: i.attentionReason,
          text: i.text,
        })),
        openItemIds: idea.gate.openItemIds,
      };
    },
  }),
} as const;

export type CommandName = keyof typeof commands;

/** Run one item-scoped mutation as an operation (request id, identity, optional version check). */
async function itemOp<T>(
  db: Db,
  name: string,
  itemId: string,
  input: { meta: Meta },
  version: number | undefined,
  fn: (trx: Parameters<Parameters<typeof applyOperation>[2]>[0]) => Promise<T>,
) {
  const item = await requireItem(db, itemId);
  const outcome = await applyOperation(
    db,
    {
      name,
      ideaId: item.idea_id,
      meta: toOperationMeta(input.meta, version),
      input: payloadOf(input),
    },
    fn,
  );
  return { result: outcome.result, inputVersion: outcome.inputVersion, replayed: outcome.replayed };
}

/** Machine-readable catalogue: name, description and JSON Schema of every command. */
export function describeCommands() {
  return Object.entries(commands).map(([name, c]) => ({
    name,
    description: c.description,
    mutating: c.mutating,
    inputSchema: schemaOf(c.input),
  }));
}

/** Validate input and run a command. The single entry point for the CLI (and a future MCP server). */
export async function runCommand(
  ctx: CommandContext,
  name: string,
  rawInput: unknown,
): Promise<unknown> {
  const entry = (commands as Record<string, Command>)[name];
  if (!entry) throw invalid(`Unknown command "${name}". Run "synth help" for the list.`);
  const parsed = entry.input.safeParse(rawInput ?? {});
  if (!parsed.success)
    throw invalid(
      `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  return entry.run(ctx, parsed.data);
}
