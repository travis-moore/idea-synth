/**
 * Regression tests for four defects found by a Codex review of the multi-client work.
 * Written first and observed failing (see the commit message for the red run).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../src/agent-api/commands';
import { MockProvider, type StructuredRequest } from '../src/ai';
import { analysisRequests, tutorMoveRequest } from '../src/ai/passes';
import { openTestDb } from '../src/db/client';
import type { Db } from '../src/db/schema';
import { createApp } from '../src/server/app';
import { prepareGuidedTask } from '../src/services/guided';
import { captureIdea } from '../src/services/ideas';
import { attachEvidence, decide } from '../src/services/items';
import { enqueueJob, getJob, JobRunner, requestCancel } from '../src/services/jobs';
import {
  buildSnapshot,
  getIdea,
  getItemDetail,
  listIdeaItems,
  listRuns,
} from '../src/services/queries';
import { analysedPyramids, itemByKey, PYRAMIDS_TEXT, TestProvider } from './helpers';

let db: Db;
let n = 0;
const meta = (extra: object = {}) => ({
  requestId: `cx-${++n}-abcdef`,
  agent: 'codex',
  sessionId: 'codex-panel',
  ...extra,
});
const run = <T = Record<string, unknown>>(name: string, input: object) =>
  runCommand({ db }, name, input) as Promise<T>;
const brain = new MockProvider();
beforeEach(async () => {
  db = await openTestDb();
});

describe('1. runs submitted by an external agent keep the context that agent was given', () => {
  it('stores the served input and prompt with the run, bound to the submission', async () => {
    const { ideaId } = await run<{ ideaId: string }>('ideas.capture', {
      meta: meta(),
      text: PYRAMIDS_TEXT,
      author: 'user',
    });
    const contract = await run<{
      inputVersion: number;
      promptVersion: string;
      input: string;
      instructions: string;
    }>('passes.next', { ideaId });
    const output = await brain.generate(
      analysisRequests.extract(await buildSnapshot(db, ideaId)) as StructuredRequest<unknown>,
    );
    await run('passes.submit', {
      meta: meta(),
      ideaId,
      pass: 'extract',
      inputVersion: contract.inputVersion,
      promptVersion: contract.promptVersion,
      output,
    });

    const row = await db
      .selectFrom('analysis_runs')
      .selectAll()
      .where('idea_id', '=', ideaId)
      .executeTakeFirstOrThrow();
    const recorded = JSON.parse(row.input_json) as {
      prompt?: string;
      instructions?: string;
      input?: { idea?: { originalText?: string } };
    };
    expect(row.prompt_version).toBe(contract.promptVersion);
    expect(recorded.prompt).toBe(contract.input); // exactly what passes.next served
    expect(recorded.instructions).toBe(contract.instructions);
    expect(recorded.input?.idea?.originalText).toBe(PYRAMIDS_TEXT);
    expect(row.input_json).not.toContain('input was served to an external agent');
  });

  it('refuses a submission made against a different prompt version than the one served', async () => {
    const { ideaId } = await run<{ ideaId: string }>('ideas.capture', {
      meta: meta(),
      text: PYRAMIDS_TEXT,
      author: 'user',
    });
    const contract = await run<{ inputVersion: number }>('passes.next', { ideaId });
    const output = await brain.generate(
      analysisRequests.extract(await buildSnapshot(db, ideaId)) as StructuredRequest<unknown>,
    );
    await expect(
      run('passes.submit', {
        meta: meta(),
        ideaId,
        pass: 'extract',
        inputVersion: contract.inputVersion,
        promptVersion: 'some-older-version',
        output,
      }),
    ).rejects.toThrow(/prompt version/i);
    expect(
      (await listIdeaItems(db, ideaId)).filter((i) => i.createdByPass === 'extract'),
    ).toHaveLength(0);
  });

  it('does the same for guided tasks', async () => {
    const { sessionId, ideaId } = await run<{ sessionId: string; ideaId: string }>('guided.start', {
      meta: meta(),
      hypothesis: 'Maybe robots will mean nobody has to work.',
    });
    const task = await run<{ inputVersion: number; promptVersion: string; input: string }>(
      'guided.next',
      { sessionId },
    );
    const prepared = await prepareGuidedTask(db, sessionId);
    const output = await brain.generate(
      tutorMoveRequest(prepared.request.input as never) as StructuredRequest<unknown>,
    );
    await run('guided.submit', {
      meta: meta(),
      sessionId,
      task: 'move',
      inputVersion: task.inputVersion,
      promptVersion: task.promptVersion,
      output,
    });
    const row = await db
      .selectFrom('analysis_runs')
      .selectAll()
      .where('idea_id', '=', ideaId)
      .executeTakeFirstOrThrow();
    expect((JSON.parse(row.input_json) as { prompt?: string }).prompt).toBe(task.input);
  });
});

describe('2. cancelling a job stops it before anything further is applied', () => {
  /** Ignores abort signals, like a model call that returns anyway; cancels the job mid-pass. */
  class CancelsDuring extends TestProvider {
    seen: string[] = [];
    constructor(
      private readonly pass: string,
      private readonly cancel: () => Promise<unknown>,
    ) {
      super();
    }
    override async generate<T>(request: StructuredRequest<T>): Promise<unknown> {
      this.seen.push(request.pass);
      const output = await this.inner.generate(request);
      if (request.pass === this.pass) await this.cancel();
      return output;
    }
  }

  for (const [during, keptPasses] of [
    ['extract', []],
    ['explore', ['extract']],
  ] as const)
    it(`cancelled during ${during}: that result is not applied, earlier history is kept`, async () => {
      let jobId = '';
      const provider = new CancelsDuring(during, () => requestCancel(db, jobId));
      const ctx = { db, provider };
      const idea = await captureIdea(db, { text: PYRAMIDS_TEXT });
      // A slow heartbeat: cancellation must not depend on it.
      const runner = new JobRunner(ctx, { pollMs: 5, heartbeatMs: 60_000 });
      jobId = (await enqueueJob(ctx, { ideaId: idea.id, payload: { kind: 'analyze' } })).id;
      await runner.drain();

      expect(await getJob(db, jobId)).toMatchObject({
        status: 'cancelled',
        errorCode: 'cancelled',
      });
      const completed = (await listRuns(db, idea.id))
        .filter((r) => r.status === 'completed')
        .map((r) => r.pass);
      expect(completed).toEqual(keptPasses);
      expect(provider.seen).toEqual(during === 'extract' ? ['extract'] : ['extract', 'explore']);
      expect((await getIdea(db, idea.id)).stage).toBe('captured');
    });
});

describe('3. an external agent reply is bound to the thread it read', () => {
  it("refuses a reply written before the user's newest message, and requires the sequence", async () => {
    const ctx = { db, provider: new TestProvider() };
    const idea = await analysedPyramids(ctx);
    const item = await itemByKey(ctx, idea.id, 'a_selection');
    await run('items.discuss', {
      meta: meta(),
      itemId: item.id,
      author: 'user',
      body: 'first thought',
    });
    const read = (await getItemDetail(db, item.id)).messages.at(-1)!.seq; // the agent reads the thread here
    await run('items.discuss', {
      meta: meta(),
      itemId: item.id,
      author: 'user',
      body: 'actually, I changed my mind',
    });

    await expect(
      run('items.discuss', {
        meta: meta(),
        itemId: item.id,
        author: 'agent',
        body: 'Replying to your first thought.',
        expectedThreadSeq: read,
      }),
    ).rejects.toMatchObject({ details: { reason: 'stale_input' } });
    await expect(
      run('items.discuss', {
        meta: meta(),
        itemId: item.id,
        author: 'agent',
        body: 'No sequence given.',
      }),
    ).rejects.toThrow(/expectedThreadSeq/);

    await run('items.discuss', {
      meta: meta(),
      itemId: item.id,
      author: 'agent',
      body: 'Replying to both.',
      expectedThreadSeq: read + 1,
    });
    expect((await getItemDetail(db, item.id)).messages.map((m) => m.author)).toEqual([
      'user',
      'user',
      'agent',
    ]);
  });
});

describe('4. user-authored evidence and rationale keep their exact wording', () => {
  const exact = '  Bettencourt et al. found superlinear scaling.\n\n';
  it('through the service', async () => {
    const ctx = { db, provider: new TestProvider() };
    const idea = await analysedPyramids(ctx);
    const target = await itemByKey(ctx, idea.id, 'e_hypothesis');
    const evidence = await attachEvidence(db, target.id, {
      text: exact,
      stance: 'for',
      sourceTitle: 'PNAS 2007',
      excerpt: '  “superlinear”  ',
    });
    const detail = await getItemDetail(db, evidence.id);
    expect(detail.item.text).toBe(exact);
    expect(detail.revisions[0]!.text).toBe(exact);
    expect((await getItemDetail(db, target.id)).evidence[0]!.excerpt).toBe('  “superlinear”  ');

    await decide(db, target.id, {
      decision: 'qualify',
      qualification: ' only in cities\n',
      rationale: '  because of the above ',
    });
    expect((await getItemDetail(db, target.id)).decisions.at(-1)).toMatchObject({
      qualification: ' only in cities\n',
      rationale: '  because of the above ',
    });
  });

  it('through the HTTP endpoint', async () => {
    const ctx = { db, provider: new TestProvider() };
    const idea = await analysedPyramids(ctx);
    const target = await itemByKey(ctx, idea.id, 'e_hypothesis');
    const app = createApp(ctx, { security: 'disabled-for-tests' });
    const res = await app.request(`/api/items/${target.id}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: exact, stance: 'against', sourceTitle: 'A source' }),
    });
    expect(res.status).toBe(201);
    const evidenceItem = (await listIdeaItems(db, idea.id)).find(
      (i) => i.kind === 'evidence' && i.origin === 'user',
    )!;
    expect(evidenceItem.text).toBe(exact);
  });
});
