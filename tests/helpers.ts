import { MockProvider } from '../src/ai';
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
