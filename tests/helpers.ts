import { MockProvider, type ModelProvider, type StructuredRequest } from '../src/ai';
import type { ProviderInfo } from '../src/ai/provider';
import { PYRAMIDS_TEXT } from '../src/ai/mock/pyramids';
import { openTestDb } from '../src/db/client';
import type { AppContext } from '../src/services/context';
import { captureIdea } from '../src/services/ideas';
import { runAnalysis } from '../src/services/pipeline';
import { listIdeaItems } from '../src/services/queries';

export { PYRAMIDS_TEXT };

/** A fresh in-memory database with the deterministic mock provider. */
export async function testContext(): Promise<AppContext> {
  return { db: await openTestDb(), provider: new MockProvider() };
}

/** The pyramids idea, captured and analysed (Steps 1-5), ready for review. */
export async function analysedPyramids(ctx: AppContext) {
  const idea = await captureIdea(ctx.db, { text: PYRAMIDS_TEXT });
  await runAnalysis(ctx, idea.id);
  return idea;
}

/** Look an item up by the key the mock gave it (e.g. "e_caused"). */
export async function itemByKey(ctx: AppContext, ideaId: string, key: string) {
  const row = await ctx.db
    .selectFrom('reasoning_items')
    .selectAll()
    .where('idea_id', '=', ideaId)
    .where('run_key', '=', key)
    .executeTakeFirstOrThrow();
  const dto = (await listIdeaItems(ctx.db, ideaId)).find((i) => i.id === row.id)!;
  return dto;
}

/** Base for test doubles: behaves like the mock unless `generate` is overridden. */
export class TestProvider implements ModelProvider {
  readonly name: string = 'test-double';
  readonly model = 'test';
  readonly live = false;
  readonly canReason = true;
  status(): string {
    return 'test double';
  }
  protected readonly inner = new MockProvider();
  info(): ProviderInfo {
    return { name: this.name, model: this.model, modelSource: 'provider', authMode: 'none' };
  }
  generate<T>(request: StructuredRequest<T>): Promise<unknown> {
    return this.inner.generate(request);
  }
}

/** A provider from a plain function, for one-off racing/failing scenarios. */
export function providerFrom(
  generate: (request: StructuredRequest<unknown>, fallback: MockProvider) => Promise<unknown>,
): ModelProvider {
  const fallback = new MockProvider();
  return Object.assign(new TestProvider(), {
    generate: (request: StructuredRequest<unknown>) => generate(request, fallback),
  }) as ModelProvider;
}

/** The override a user gives after looking at everything currently blocking the gate. */
export async function overrideAll(ctx: AppContext, ideaId: string) {
  const { listInbox } = await import('../src/services/queries');
  return { override: { blockingItemIds: (await listInbox(ctx.db, ideaId)).map((i) => i.id) } };
}
