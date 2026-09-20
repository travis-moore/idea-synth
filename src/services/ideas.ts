import type { DbOrTrx, IdeasTable } from '../db/schema';
import { invalid } from '../domain/errors';
import { newId } from '../domain/ids';
import type { IdeaSource, IdeaStage, Origin } from '../domain/vocabulary';
import { createItem, inTransaction, logEvent, nowIso } from './store';

const DEFAULT_WORKSPACE = 'ws_default';

async function ensureWorkspace(db: DbOrTrx): Promise<string> {
  const existing = await db
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', DEFAULT_WORKSPACE)
    .executeTakeFirst();
  if (!existing)
    await db
      .insertInto('workspaces')
      .values({ id: DEFAULT_WORKSPACE, name: 'My ideas', created_at: nowIso() })
      .execute();
  return DEFAULT_WORKSPACE;
}

export const titleFrom = (text: string) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line;
};

export interface CaptureInput {
  text: string;
  title?: string | undefined;
  source?: IdeaSource;
  stage?: IdeaStage;
  /** Who wrote `text`. Only a promoted tangent can start from agent-written words. */
  rootOrigin?: Origin;
  sourceItemId?: string;
  sourceIdeaId?: string;
}

/**
 * Step 1 - Capture. Stores the text exactly as given (no trimming, no clean-up) and
 * creates the root `original_idea` item that everything else will trace back to.
 */
export async function captureIdea(db: DbOrTrx, input: CaptureInput): Promise<IdeasTable> {
  if (!input.text.trim()) throw invalid('Write the idea down first, in your own words.');
  return inTransaction(db, async (trx) => {
    const now = nowIso();
    const idea: IdeasTable = {
      id: newId('idea'),
      workspace_id: await ensureWorkspace(trx),
      title: input.title?.trim() || titleFrom(input.text),
      original_text: input.text,
      source: input.source ?? 'captured',
      stage: input.stage ?? 'captured',
      source_item_id: input.sourceItemId ?? null,
      source_idea_id: input.sourceIdeaId ?? null,
      revision: 0,
      created_at: now,
      updated_at: now,
    };
    await trx.insertInto('ideas').values(idea).execute();
    await logEvent(trx, {
      ideaId: idea.id,
      type: 'idea.captured',
      actor: (input.rootOrigin ?? 'user') === 'user' ? 'user' : 'agent',
      payload: { source: idea.source, rootOrigin: input.rootOrigin ?? 'user' },
    });
    await createItem(trx, {
      idea,
      kind: 'original_idea',
      origin: input.rootOrigin ?? 'user',
      text: input.text,
      verbatim: true,
      via: 'capture',
    });
    return idea;
  });
}

export async function setStage(db: DbOrTrx, ideaId: string, from: IdeaStage, to: IdeaStage) {
  if (from === to) return;
  await db
    .updateTable('ideas')
    .set({ stage: to, updated_at: nowIso() })
    .where('id', '=', ideaId)
    .execute();
  // A guided session is over once its idea enters the normal workflow, whoever drove it.
  if (from === 'guided')
    await db
      .updateTable('guided_sessions')
      .set({ status: 'handed_off', updated_at: nowIso() })
      .where('idea_id', '=', ideaId)
      .execute();
  await logEvent(db, {
    ideaId,
    type: 'idea.stage_changed',
    actor: 'system',
    payload: { from, to },
  });
}
