/**
 * HTTP API. Thin by design: parse and validate the request, call one service, return a
 * DTO. No reasoning rules live here.
 */
import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ApiErrorDto, MetaDto } from '../api-types';
import { DomainError, type DomainErrorCode } from '../domain/errors';
import { PREMISE_STANCES } from '../domain/scaffolding';
import { decisionTypeSchema, itemKindSchema } from '../domain/vocabulary';
import type { AppContext } from '../services/context';
import {
  continueSession,
  getGuidedSession,
  handOffToSynthesis,
  replyToTutor,
  respondToPremise,
  startGuidedSession,
} from '../services/guided';
import { captureIdea } from '../services/ideas';
import {
  attachEvidence,
  branchItem,
  decide,
  discuss,
  mergeItems,
  promoteTangent,
  reviseItem,
  splitItem,
  supersedeItem,
} from '../services/items';
import { runAnalysis, runSynthesis } from '../services/pipeline';
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

const STATUS: Record<DomainErrorCode, 400 | 403 | 404 | 409 | 502> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  upstream: 502,
};

const text = z.string().trim().min(1).max(20000);
const optionalText = z.string().trim().max(20000).optional();
const childSchema = z.object({ text, kind: itemKindSchema.optional() });

const bodies = {
  captureIdea: z.object({ text: z.string().min(1).max(50000), title: optionalText }),
  synthesize: z.object({ force: z.boolean().optional() }),
  message: z.object({ body: text, askAgent: z.boolean().optional() }),
  decision: z.object({
    decision: decisionTypeSchema,
    rationale: optionalText,
    qualification: optionalText,
  }),
  split: z.object({ children: z.array(childSchema).min(2).max(12), rationale: optionalText }),
  branch: z.object({ text, kind: itemKindSchema.optional(), asTangent: z.boolean().optional() }),
  merge: z.object({
    itemIds: z.array(z.string()).min(2),
    text,
    kind: itemKindSchema.optional(),
    rationale: optionalText,
  }),
  supersede: z.object({
    text,
    kind: itemKindSchema.optional(),
    reason: optionalText,
    causedByItemId: z.string().optional(),
  }),
  revise: z.object({ text, reason: optionalText, causedByItemId: z.string().optional() }),
  evidence: z.object({
    text,
    stance: z.enum(['for', 'against']),
    sourceTitle: text,
    url: z.string().url().optional().or(z.literal('')),
    excerpt: optionalText,
  }),
  promote: z.object({ framing: optionalText }),
  startGuided: z.object({ hypothesis: z.string().min(1).max(5000) }),
  reply: z.object({ body: text }),
  premise: z.object({ stance: z.enum(PREMISE_STANCES), body: optionalText }),
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

export function createApp(ctx: AppContext, options: { staticDir?: string } = {}) {
  const app = new Hono();
  const { db } = ctx;

  app.onError((error, c) => {
    if (error instanceof DomainError) {
      const body: ApiErrorDto = { error: { code: error.code, message: error.message } };
      return c.json(body, STATUS[error.code]);
    }
    console.error(error);
    const body: ApiErrorDto = {
      error: { code: 'internal', message: 'Something went wrong on the server.' },
    };
    return c.json(body, 500);
  });

  const api = new Hono();

  api.get('/meta', (c) => {
    const meta: MetaDto = {
      provider: ctx.provider.name,
      model: ctx.provider.model,
      live: ctx.provider.live,
    };
    return c.json(meta);
  });

  // --- Ideas --------------------------------------------------------------------------
  api.get('/ideas', async (c) => c.json(await listIdeas(db)));
  api.post('/ideas', async (c) => {
    const idea = await captureIdea(db, await parse(c, bodies.captureIdea));
    return c.json(await getIdea(db, idea.id), 201);
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
    await runAnalysis(ctx, c.req.param('id'));
    return c.json(await getIdea(db, c.req.param('id')));
  });
  api.post('/ideas/:id/synthesize', async (c) => {
    await runSynthesis(ctx, c.req.param('id'), await parse(c, bodies.synthesize));
    return c.json(await getSynthesis(db, c.req.param('id')));
  });

  // --- Views (one idea with ?ideaId=, or the whole workspace) ---------------------------
  api.get('/inbox', async (c) => c.json(await listInbox(db, c.req.query('ideaId'))));
  api.get('/open-questions', async (c) =>
    c.json(await listOpenQuestions(db, c.req.query('ideaId'))),
  );
  api.get('/tangents', async (c) => c.json(await listTangents(db, c.req.query('ideaId'))));

  // --- Items ---------------------------------------------------------------------------
  api.post('/items/merge', async (c) => {
    const merged = await mergeItems(db, await parse(c, bodies.merge));
    return c.json(await getItemDetail(db, merged.id), 201);
  });
  api.get('/items/:id', async (c) => c.json(await getItemDetail(db, c.req.param('id'))));
  api.post('/items/:id/messages', async (c) => {
    await discuss(ctx, c.req.param('id'), await parse(c, bodies.message));
    return c.json(await getItemDetail(db, c.req.param('id')), 201);
  });
  api.post('/items/:id/decisions', async (c) => {
    await decide(db, c.req.param('id'), await parse(c, bodies.decision));
    return c.json(await getItemDetail(db, c.req.param('id')), 201);
  });
  api.post('/items/:id/split', async (c) => {
    await splitItem(db, c.req.param('id'), await parse(c, bodies.split));
    return c.json(await getItemDetail(db, c.req.param('id')), 201);
  });
  api.post('/items/:id/branch', async (c) => {
    const child = await branchItem(db, c.req.param('id'), await parse(c, bodies.branch));
    return c.json(await getItemDetail(db, child.id), 201);
  });
  api.post('/items/:id/supersede', async (c) => {
    const replacement = await supersedeItem(
      db,
      c.req.param('id'),
      await parse(c, bodies.supersede),
    );
    return c.json(await getItemDetail(db, replacement.id), 201);
  });
  api.post('/items/:id/revisions', async (c) => {
    await reviseItem(db, c.req.param('id'), await parse(c, bodies.revise));
    return c.json(await getItemDetail(db, c.req.param('id')), 201);
  });
  api.post('/items/:id/evidence', async (c) => {
    const body = await parse(c, bodies.evidence);
    await attachEvidence(db, c.req.param('id'), { ...body, url: body.url || undefined });
    return c.json(await getItemDetail(db, c.req.param('id')), 201);
  });
  api.post('/items/:id/promote', async (c) => {
    const idea = await promoteTangent(db, c.req.param('id'), await parse(c, bodies.promote));
    return c.json(await getIdea(db, idea.id), 201);
  });

  // --- Guided idea development ------------------------------------------------------------
  api.post('/guided', async (c) => {
    const sessionId = await startGuidedSession(ctx, await parse(c, bodies.startGuided));
    return c.json(await getGuidedSession(db, sessionId), 201);
  });
  api.get('/guided/:id', async (c) => c.json(await getGuidedSession(db, c.req.param('id'))));
  api.post('/guided/:id/reply', async (c) => {
    await replyToTutor(ctx, c.req.param('id'), await parse(c, bodies.reply));
    return c.json(await getGuidedSession(db, c.req.param('id')));
  });
  api.post('/guided/:id/premise', async (c) => {
    await respondToPremise(ctx, c.req.param('id'), await parse(c, bodies.premise));
    return c.json(await getGuidedSession(db, c.req.param('id')));
  });
  api.post('/guided/:id/continue', async (c) => {
    await continueSession(ctx, c.req.param('id'));
    return c.json(await getGuidedSession(db, c.req.param('id')));
  });
  api.post('/guided/:id/handoff', async (c) => {
    const ideaId = await handOffToSynthesis(ctx, c.req.param('id'));
    return c.json(await getIdea(db, ideaId));
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
