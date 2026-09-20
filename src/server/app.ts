/**
 * HTTP API for the web client. Thin by design: validate, call one service, return a DTO.
 *
 * Nothing here waits for a model. Reasoning requested from the browser becomes a durable
 * job (services/jobs.ts); the user's own input (a message, a guided answer, a decision) is
 * committed before the job is queued, so closing the tab loses nothing.
 */
import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ApiErrorDto, ChangesDto, MetaDto } from '../api-types';
import { DomainError, type DomainErrorCode } from '../domain/errors';
import { PREMISE_STANCES } from '../domain/scaffolding';
import { authorSchema, decisionTypeSchema, itemKindSchema } from '../domain/vocabulary';
import { enforceGate } from '../services/apply';
import type { AppContext } from '../services/context';
import {
  assertReadyForHandoff,
  createGuidedSession,
  getGuidedSession,
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
import { enqueueJob, getJob, listJobs, requestCancel, type JobRunner } from '../services/jobs';
import { applyOperation, CONTRACT_VERSION, WEB_USER } from '../services/operation';
import { assertSynthesisStage } from '../services/pipeline';
import {
  getGraph,
  getIdea,
  getItemDetail,
  getSynthesis,
  listIdeaEvents,
  listIdeas,
  listInbox,
  listOpenQuestions,
  listRuns,
  listTangents,
} from '../services/queries';
import { requireItem } from '../services/store';
import { guard, type SecurityConfig } from './security';

const STATUS: Record<DomainErrorCode, 400 | 403 | 404 | 409 | 502> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  upstream: 502,
};

const text = z.string().trim().min(1).max(20000);
const optionalText = z.string().trim().max(20000).optional();
/** User-typed content that must be stored exactly: validated for emptiness, never trimmed. */
const verbatim = z
  .string()
  .max(50000)
  .refine((s) => s.trim().length > 0, 'must not be empty');
const author = authorSchema.optional();
const childSchema = z.object({ text: verbatim, kind: itemKindSchema.optional(), author });

const bodies = {
  captureIdea: z.object({ text: verbatim, title: optionalText }),
  synthesize: z.object({ overrideBlockingItemIds: z.array(z.string()).optional() }),
  message: z.object({ body: verbatim, askAgent: z.boolean().optional() }),
  decision: z.object({
    decision: decisionTypeSchema,
    rationale: optionalText,
    qualification: optionalText,
  }),
  split: z.object({ children: z.array(childSchema).min(2).max(12), rationale: optionalText }),
  branch: z.object({
    text: verbatim,
    kind: itemKindSchema.optional(),
    asTangent: z.boolean().optional(),
  }),
  merge: z.object({
    itemIds: z.array(z.string()).min(2),
    text: verbatim,
    kind: itemKindSchema.optional(),
    rationale: optionalText,
  }),
  supersede: z.object({
    text: verbatim,
    kind: itemKindSchema.optional(),
    reason: optionalText,
    causedByItemId: z.string().optional(),
  }),
  revise: z.object({ text: verbatim, reason: optionalText, causedByItemId: z.string().optional() }),
  evidence: z.object({
    text,
    stance: z.enum(['for', 'against']),
    sourceTitle: text,
    url: z.string().url().optional().or(z.literal('')),
    excerpt: optionalText,
  }),
  promote: z.object({ framing: z.string().max(50000).optional() }),
  startGuided: z.object({ hypothesis: verbatim }),
  reply: z.object({ body: verbatim }),
  premise: z.object({ stance: z.enum(PREMISE_STANCES), body: z.string().max(50000).optional() }),
};

async function parse<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new DomainError(
      'invalid',
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  return result.data;
}

export interface AppOptions {
  /** Serve the built web client from here (production mode). */
  staticDir?: string;
  /**
   * Host/origin/token protection. Required: pass a config, or the literal
   * 'disabled-for-tests' (in-process tests that never open a socket).
   */
  security: SecurityConfig | 'disabled-for-tests';
  /** Lets a request nudge the runner instead of waiting for its next poll. */
  runner?: JobRunner;
}

export function createApp(ctx: AppContext, options: AppOptions) {
  const app = new Hono();
  const { db } = ctx;
  const kick = () => void options.runner?.start();

  app.onError((error, c) => {
    if (error instanceof DomainError) {
      const body: ApiErrorDto = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      };
      return c.json(body, STATUS[error.code]);
    }
    console.error(error);
    const body: ApiErrorDto = {
      error: { code: 'internal', message: 'Something went wrong on the server.' },
    };
    return c.json(body, 500);
  });

  const api = new Hono();
  if (options.security !== 'disabled-for-tests') api.use('*', guard(options.security));
  const token = options.security === 'disabled-for-tests' ? '' : options.security.token;

  /** The web user acting directly: tag everything the operation writes with its envelope. */
  const asUser = <T>(
    name: string,
    ideaId: string | null,
    fn: Parameters<typeof applyOperation<T>>[2],
  ) => applyOperation(db, { name, ideaId, meta: WEB_USER }, fn).then((o) => o.result);
  const ideaOf = async (itemId: string) => (await requireItem(db, itemId)).idea_id;

  api.get('/meta', (c) => {
    const info = ctx.provider.info();
    const meta: MetaDto = {
      provider: ctx.provider.name,
      model: info.model,
      live: ctx.provider.live,
      canReason: ctx.provider.canReason,
      authMode: info.authMode,
      providerStatus: ctx.provider.status(),
      contractVersion: CONTRACT_VERSION,
    };
    return c.json(meta);
  });

  // The token is only readable by a same-origin page: the guard has already rejected other
  // hosts/origins, and without CORS headers no other site can read this response.
  api.get('/session', (c) => c.json({ token }));

  // Cheap change feed: the UI polls this and refetches only what moved.
  api.get('/changes', async (c) => {
    const [ideas, active] = await Promise.all([
      db.selectFrom('ideas').select(['id', 'revision']).execute(),
      listJobs(db, { activeOnly: true }),
    ]);
    const body: ChangesDto = {
      ideas: Object.fromEntries(ideas.map((i) => [i.id, Number(i.revision)])),
      activeJobs: active.length,
    };
    return c.json(body);
  });

  // --- Ideas --------------------------------------------------------------------------
  api.get('/ideas', async (c) => c.json(await listIdeas(db)));
  api.post('/ideas', async (c) => {
    const body = await parse(c, bodies.captureIdea);
    const idea = await asUser('ideas.capture', null, async (trx) => ({
      ideaId: (await captureIdea(trx, body)).id,
    }));
    return c.json(await getIdea(db, idea.ideaId), 201);
  });
  api.get('/ideas/:id', async (c) => c.json(await getIdea(db, c.req.param('id'))));
  api.get('/ideas/:id/graph', async (c) => c.json(await getGraph(db, c.req.param('id'))));
  api.get('/ideas/:id/runs', async (c) => c.json(await listRuns(db, c.req.param('id'))));
  api.get('/ideas/:id/events', async (c) => c.json(await listIdeaEvents(db, c.req.param('id'))));
  api.get('/ideas/:id/synthesis', async (c) => {
    const version = c.req.query('version');
    return c.json(await getSynthesis(db, c.req.param('id'), version ? Number(version) : undefined));
  });
  api.post('/ideas/:id/analyze', async (c) => {
    const job = await enqueueJob(ctx, { ideaId: c.req.param('id'), payload: { kind: 'analyze' } });
    kick();
    return c.json(job, 202);
  });
  api.post('/ideas/:id/synthesize', async (c) => {
    const ideaId = c.req.param('id');
    const body = await parse(c, bodies.synthesize);
    // The override names the items the user was shown. It is bound to them: see enforceGate.
    const override = body.overrideBlockingItemIds?.length
      ? { blockingItemIds: body.overrideBlockingItemIds }
      : undefined;
    await assertSynthesisStage(db, ideaId);
    await enforceGate(db, ideaId, override); // fail fast (409 + the blocking ids); re-checked at commit
    const latest = await getSynthesis(db, ideaId);
    const job = await enqueueJob(ctx, {
      ideaId,
      payload: { kind: 'synthesize', override, baseVersion: latest?.version ?? 0 },
    });
    kick();
    return c.json(job, 202);
  });

  // --- Jobs ---------------------------------------------------------------------------
  api.get('/jobs', async (c) =>
    c.json(
      await listJobs(db, {
        ideaId: c.req.query('ideaId'),
        activeOnly: c.req.query('active') === '1',
      }),
    ),
  );
  api.get('/jobs/:id', async (c) => c.json(await getJob(db, c.req.param('id'))));
  api.post('/jobs/:id/cancel', async (c) => c.json(await requestCancel(db, c.req.param('id'))));

  // --- Views (one idea with ?ideaId=, or the whole workspace) ---------------------------
  api.get('/inbox', async (c) => c.json(await listInbox(db, c.req.query('ideaId'))));
  api.get('/open-questions', async (c) =>
    c.json(await listOpenQuestions(db, c.req.query('ideaId'))),
  );
  api.get('/tangents', async (c) => c.json(await listTangents(db, c.req.query('ideaId'))));

  // --- Items ---------------------------------------------------------------------------
  api.post('/items/merge', async (c) => {
    const body = await parse(c, bodies.merge);
    const ideaId = await ideaOf(body.itemIds[0]!);
    const merged = await asUser('items.merge', ideaId, async (trx) => ({
      id: (await mergeItems(trx, body)).id,
    }));
    return c.json(await getItemDetail(db, merged.id), 201);
  });
  api.get('/items/:id', async (c) => c.json(await getItemDetail(db, c.req.param('id'))));
  api.post('/items/:id/messages', async (c) => {
    const itemId = c.req.param('id');
    const body = await parse(c, bodies.message);
    const ideaId = await ideaOf(itemId);
    // The user's message is committed first; the reply is a separate, durable job.
    const posted = await asUser('items.discuss', ideaId, (trx) =>
      postContribution(trx, itemId, { author: 'user', body: body.body }),
    );
    const job = body.askAgent
      ? await enqueueJob(ctx, {
          ideaId,
          payload: { kind: 'discuss_reply', itemId, afterSeq: posted.seq },
        })
      : null;
    if (job) kick();
    return c.json({ detail: await getItemDetail(db, itemId), job }, 201);
  });
  api.post('/items/:id/decisions', async (c) => {
    const itemId = c.req.param('id');
    const body = await parse(c, bodies.decision);
    await asUser('items.decide', await ideaOf(itemId), async (trx) => ({
      status: await decide(trx, itemId, body),
    }));
    return c.json(await getItemDetail(db, itemId), 201);
  });
  api.post('/items/:id/split', async (c) => {
    const itemId = c.req.param('id');
    const body = await parse(c, bodies.split);
    await asUser('items.split', await ideaOf(itemId), async (trx) => ({
      childIds: (await splitItem(trx, itemId, body)).map((child) => child.id),
    }));
    return c.json(await getItemDetail(db, itemId), 201);
  });
  api.post('/items/:id/branch', async (c) => {
    const itemId = c.req.param('id');
    const body = await parse(c, bodies.branch);
    const child = await asUser('items.branch', await ideaOf(itemId), async (trx) => ({
      id: (await branchItem(trx, itemId, { ...body, author: 'user' })).id,
    }));
    return c.json(await getItemDetail(db, child.id), 201);
  });
  api.post('/items/:id/supersede', async (c) => {
    const itemId = c.req.param('id');
    const body = await parse(c, bodies.supersede);
    const replacement = await asUser('items.supersede', await ideaOf(itemId), async (trx) => ({
      id: (await supersedeItem(trx, itemId, { ...body, author: 'user' })).id,
    }));
    return c.json(await getItemDetail(db, replacement.id), 201);
  });
  api.post('/items/:id/revisions', async (c) => {
    const itemId = c.req.param('id');
    const body = await parse(c, bodies.revise);
    await asUser('items.revise', await ideaOf(itemId), async (trx) => ({
      seq: await reviseItem(trx, itemId, { ...body, author: 'user' }),
    }));
    return c.json(await getItemDetail(db, itemId), 201);
  });
  api.post('/items/:id/evidence', async (c) => {
    const itemId = c.req.param('id');
    const body = await parse(c, bodies.evidence);
    await asUser('items.evidence', await ideaOf(itemId), async (trx) => ({
      id: (
        await attachEvidence(trx, itemId, { ...body, url: body.url || undefined, author: 'user' })
      ).id,
    }));
    return c.json(await getItemDetail(db, itemId), 201);
  });
  api.post('/items/:id/promote', async (c) => {
    const itemId = c.req.param('id');
    const body = await parse(c, bodies.promote);
    const idea = await asUser('items.promote', await ideaOf(itemId), async (trx) => ({
      id: (await promoteTangent(trx, itemId, { ...body, framingAuthor: 'user' })).id,
    }));
    return c.json(await getIdea(db, idea.id), 201);
  });

  // --- Guided idea development ------------------------------------------------------------
  const guidedTurn = async (sessionId: string) => {
    const session = await getGuidedSession(db, sessionId);
    if (session.pendingTask === 'assessment' || session.pendingTask === 'move') {
      await enqueueJob(ctx, {
        ideaId: session.ideaId,
        payload: { kind: 'guided_turn', sessionId },
      });
      kick();
    }
    return getGuidedSession(db, sessionId);
  };
  api.post('/guided', async (c) => {
    const body = await parse(c, bodies.startGuided);
    const created = await asUser('guided.start', null, (trx) => createGuidedSession(trx, body));
    return c.json(
      await guidedTurn(created.sessionId).catch(() => getGuidedSession(db, created.sessionId)),
      201,
    );
  });
  api.get('/guided/:id', async (c) => c.json(await getGuidedSession(db, c.req.param('id'))));
  api.post('/guided/:id/reply', async (c) => {
    const sessionId = c.req.param('id');
    const body = await parse(c, bodies.reply);
    const session = await getGuidedSession(db, sessionId);
    // Stored exactly as typed, before any model is involved.
    await asUser('guided.answer', session.ideaId, async (trx) => ({
      stepId: await recordAnswer(trx, sessionId, body.body),
    }));
    return c.json(await guidedTurn(sessionId), 201);
  });
  api.post('/guided/:id/premise', async (c) => {
    const sessionId = c.req.param('id');
    const body = await parse(c, bodies.premise);
    const session = await getGuidedSession(db, sessionId);
    await asUser('guided.premise', session.ideaId, async (trx) => {
      await recordPremiseResponse(trx, sessionId, body);
      return { ok: true };
    });
    return c.json(await guidedTurn(sessionId), 201);
  });
  // Both retries queue the same job: it does whichever step is owed (assessment, then move).
  api.post('/guided/:id/retry-assessment', async (c) =>
    c.json(await guidedTurn(c.req.param('id')), 202),
  );
  api.post('/guided/:id/continue', async (c) => c.json(await guidedTurn(c.req.param('id')), 202));
  api.post('/guided/:id/handoff', async (c) => {
    const sessionId = c.req.param('id');
    const session = await assertReadyForHandoff(db, sessionId);
    const job = await enqueueJob(ctx, {
      ideaId: session.idea_id,
      payload: { kind: 'guided_handoff', sessionId },
    });
    kick();
    return c.json(job, 202);
  });

  api.all('*', (c) => {
    const body: ApiErrorDto = { error: { code: 'not_found', message: 'No such API route.' } };
    return c.json(body, 404);
  });

  app.route('/api', api);

  // Production: serve the built web client, with index.html as the SPA fallback.
  const staticDir = options.staticDir;
  if (staticDir && existsSync(staticDir)) {
    app.use('*', serveStatic({ root: staticDir }));
    app.get('*', serveStatic({ root: staticDir, path: 'index.html' }));
  }
  return app;
}
