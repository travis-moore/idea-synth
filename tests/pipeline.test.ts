import { describe, expect, it } from 'vitest';
import type { StructuredRequest } from '../src/ai';
import { openTestDb } from '../src/db/client';
import { ANALYSIS_PASS_ORDER, ROLE_OF_PASS } from '../src/domain/vocabulary';
import { captureIdea } from '../src/services/ideas';
import { runAnalysis, runSynthesis } from '../src/services/pipeline';
import { getIdea, getSynthesis, listIdeaItems, listRuns } from '../src/services/queries';
import { overrideAll, PYRAMIDS_TEXT, testContext, TestProvider } from './helpers';

/** Wraps the mock, replacing the output of one pass. */
class TamperingProvider extends TestProvider {
  override readonly name = 'tampering';
  constructor(
    private readonly pass: string,
    private readonly tamper: (output: unknown) => unknown,
    public enabled = true,
  ) {
    super();
  }
  override async generate<T>(request: StructuredRequest<T>): Promise<unknown> {
    const output = await this.inner.generate(request);
    return this.enabled && request.pass === this.pass ? this.tamper(output) : output;
  }
}

describe('pass ordering', () => {
  it('runs the Explorer before either sceptical pass', () => {
    const roles = ANALYSIS_PASS_ORDER.map((p) => ROLE_OF_PASS[p]);
    expect(roles.indexOf('explorer')).toBeLessThan(roles.indexOf('skeptic'));
  });

  it('records one run per pass, in order, with the provider and prompt version', async () => {
    const ctx = await testContext();
    const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
    await runAnalysis(ctx, idea.id);
    const runs = await listRuns(ctx.db, idea.id);
    expect(runs.map((r) => r.pass)).toEqual(['extract', 'explore', 'epistemic', 'adversarial']);
    expect(
      runs.every((r) => r.status === 'completed' && r.provider === 'mock' && r.promptVersion),
    ).toBe(true);
    await expect(runAnalysis(ctx, idea.id)).rejects.toThrow(/already been analysed/);
  });
});

describe('structured output is validated before anything is written', () => {
  it('rejects prose / malformed output and records a failed run', async () => {
    const provider = new TamperingProvider('explore', () => 'Sure! Here are some thoughts...');
    const ctx = { db: await openTestDb(), provider };
    const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
    await expect(runAnalysis(ctx, idea.id)).rejects.toThrow(/explore pass failed/);

    const runs = await listRuns(ctx.db, idea.id);
    expect(runs.map((r) => [r.pass, r.status])).toEqual([
      ['extract', 'completed'],
      ['explore', 'failed'],
    ]);
    expect(runs[1]!.error).toMatch(/validation/);
    expect((await getIdea(ctx.db, idea.id)).stage).toBe('captured');
    expect((await listIdeaItems(ctx.db, idea.id)).every((i) => i.createdByPass !== 'explore')).toBe(
      true,
    );

    // Resumable: the completed extract pass is not repeated.
    provider.enabled = false;
    await runAnalysis(ctx, idea.id);
    const passes = (await listRuns(ctx.db, idea.id))
      .filter((r) => r.status === 'completed')
      .map((r) => r.pass);
    expect(passes).toEqual(['extract', 'explore', 'epistemic', 'adversarial']);
    expect(
      (await listIdeaItems(ctx.db, idea.id)).filter((i) => i.createdByPass === 'extract'),
    ).toHaveLength(6);
  });

  it('rolls back the whole pass when the model references an item that does not exist', async () => {
    const provider = new TamperingProvider('adversarial', (output) => {
      const out = structuredClone(output) as { items: Array<{ links: Array<{ to: string }> }> };
      out.items.at(-1)!.links[0]!.to = 'itm_DOES_NOT_EXIST';
      return out;
    });
    const ctx = { db: await openTestDb(), provider };
    const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
    await expect(runAnalysis(ctx, idea.id)).rejects.toThrow(/unknown item/);
    const items = await listIdeaItems(ctx.db, idea.id);
    expect(items.some((i) => i.createdByPass === 'adversarial')).toBe(false);
    expect(items.some((i) => i.kind === 'objection')).toBe(false);
  });

  it('refuses a pass that tries to create kinds outside its remit', async () => {
    const provider = new TamperingProvider('explore', (output) => {
      const out = structuredClone(output) as { items: Array<{ kind: string }> };
      out.items[0]!.kind = 'conclusion';
      return out;
    });
    const ctx = { db: await openTestDb(), provider };
    const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
    await expect(runAnalysis(ctx, idea.id)).rejects.toThrow(
      /may not create items of kind "conclusion"/,
    );
  });

  it('refuses a synthesis line with no provenance', async () => {
    const provider = new TamperingProvider('synthesize', (output) => {
      const out = structuredClone(output) as { conclusions: Array<{ refs: string[] }> };
      out.conclusions[0]!.refs = [];
      return out;
    });
    const ctx = { db: await openTestDb(), provider };
    const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
    await runAnalysis(ctx, idea.id);
    await expect(runSynthesis(ctx, idea.id, await overrideAll(ctx, idea.id))).rejects.toThrow(
      /synthesize pass failed/,
    );
    expect(await getSynthesis(ctx.db, idea.id)).toBeNull();
    expect((await getIdea(ctx.db, idea.id)).stage).toBe('in_review');
  });
});

describe('the mock handles arbitrary ideas', () => {
  it('runs the full workflow on text it has never seen', async () => {
    const ctx = await testContext();
    const text =
      'Cities make people lonely because everyone is a stranger. Maybe villages are better? We should design cities like villages.';
    const idea = await captureIdea(ctx.db, { text });
    await runAnalysis(ctx, idea.id);
    const items = await listIdeaItems(ctx.db, idea.id);
    expect(items.filter((i) => i.createdByPass === 'extract').map((i) => i.kind)).toEqual([
      'causal_claim',
      'question',
      'value_judgment',
    ]);
    expect(items.find((i) => i.kind === 'value_judgment')).toMatchObject({
      epistemicVerdict: 'normative',
      status: 'needs_user',
      attentionReason: 'value_judgment_input',
    });
    await runSynthesis(ctx, idea.id, await overrideAll(ctx, idea.id));
    const synthesis = (await getSynthesis(ctx.db, idea.id))!;
    // Nothing accepted yet, so the mock must not manufacture certainty.
    expect(synthesis.body.statement).toMatch(/No items have been accepted yet/);
    expect(synthesis.body.conclusions.every((c) => c.confidence === 'tentative')).toBe(true);
  });
});
