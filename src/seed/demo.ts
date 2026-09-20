/**
 * Demo data: the motivating "pyramids" idea, captured and analysed with the mock
 * provider, plus a guided session on the "robots" hypothesis waiting at its first
 * question. No user decisions are faked: the review gate is left for the real user.
 *
 * The content demonstrates the workflow. It does not assert history.
 */
import { MockProvider } from '../ai';
import { PYRAMIDS_TEXT } from '../ai/mock/pyramids';
import type { Db } from '../db/schema';
import { startGuidedSession } from '../services/guided';
import { captureIdea } from '../services/ideas';
import { runAnalysis } from '../services/pipeline';

export const ROBOTS_HYPOTHESIS = 'Maybe robots will mean nobody has to work.';

export async function isEmpty(db: Db): Promise<boolean> {
  const row = await db.selectFrom('ideas').select('id').limit(1).executeTakeFirst();
  return row === undefined;
}

export async function seedDemo(db: Db): Promise<{ ideaId: string; guidedSessionId: string }> {
  // Always the mock: seed data must be deterministic and must never spend API credit.
  const ctx = { db, provider: new MockProvider() };
  const idea = await captureIdea(db, {
    text: PYRAMIDS_TEXT,
    title: 'Do demanding collective projects build capability?',
  });
  await runAnalysis(ctx, idea.id);
  const guidedSessionId = await startGuidedSession(ctx, { hypothesis: ROBOTS_HYPOTHESIS });
  return { ideaId: idea.id, guidedSessionId };
}
