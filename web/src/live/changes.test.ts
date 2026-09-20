import { describe, expect, it } from 'vitest';
import type { ChangesDto } from '../../../src/api-types';
import { diffChanges, hasChanges, isQueryAffected } from './changes';
import { liveLabel } from './poller';

const snapshot = (ideas: Record<string, number>, activeJobs = 0): ChangesDto => ({
  ideas,
  activeJobs,
});

describe('diffChanges', () => {
  it('treats the first snapshot as a baseline: nothing is refetched', () => {
    const diff = diffChanges(null, snapshot({ a: 3 }, 2));
    expect(hasChanges(diff)).toBe(false);
  });

  it('reports only ideas whose revision moved', () => {
    const diff = diffChanges(snapshot({ a: 3, b: 7 }), snapshot({ a: 4, b: 7 }));
    expect(diff).toEqual({ changedIdeaIds: ['a'], ideaSetChanged: false, jobsChanged: false });
  });

  it('notices new and removed ideas', () => {
    const diff = diffChanges(snapshot({ a: 1, gone: 2 }), snapshot({ a: 1, fresh: 1 }));
    expect(diff.ideaSetChanged).toBe(true);
    expect([...diff.changedIdeaIds].sort()).toEqual(['fresh', 'gone']);
  });

  it('notices a change in the number of active jobs', () => {
    const diff = diffChanges(snapshot({ a: 1 }, 0), snapshot({ a: 1 }, 1));
    expect(diff).toEqual({ changedIdeaIds: [], ideaSetChanged: false, jobsChanged: true });
    expect(hasChanges(diff)).toBe(true);
  });

  it('is quiet when nothing moved', () => {
    expect(hasChanges(diffChanges(snapshot({ a: 1 }, 1), snapshot({ a: 1 }, 1)))).toBe(false);
  });
});

describe('isQueryAffected', () => {
  const moved = diffChanges(snapshot({ a: 1, b: 1 }), snapshot({ a: 2, b: 1 }));
  const quiet = diffChanges(snapshot({ a: 1 }), snapshot({ a: 1 }));

  it('refreshes every view of the idea that moved, and none of another idea', () => {
    for (const kind of ['idea', 'graph', 'runs', 'events', 'jobs']) {
      expect(isQueryAffected([kind, 'a'], undefined, moved)).toBe(true);
      expect(isQueryAffected([kind, 'b'], undefined, moved)).toBe(false);
    }
    expect(isQueryAffected(['synthesis', 'a', 'latest'], null, moved)).toBe(true);
    expect(isQueryAffected(['synthesis', 'b', 2], null, moved)).toBe(false);
  });

  it('refreshes the cross-idea lists when any idea moved', () => {
    for (const kind of ['ideas', 'inbox', 'open-questions']) {
      expect(isQueryAffected([kind], [], moved)).toBe(true);
      expect(isQueryAffected([kind], [], quiet)).toBe(false);
    }
    expect(isQueryAffected(['tangents', 'all'], [], moved)).toBe(true);
    expect(isQueryAffected(['tangents', 'a'], [], moved)).toBe(true);
    expect(isQueryAffected(['tangents', 'b'], [], moved)).toBe(false);
  });

  it('places item and guided-session queries by the idea found in their data', () => {
    expect(isQueryAffected(['item', 'item_1'], { idea: { id: 'a' } }, moved)).toBe(true);
    expect(isQueryAffected(['item', 'item_2'], { idea: { id: 'b' } }, moved)).toBe(false);
    expect(isQueryAffected(['guided', 'gs_1'], { ideaId: 'a' }, moved)).toBe(true);
    expect(isQueryAffected(['guided', 'gs_2'], { ideaId: 'b' }, moved)).toBe(false);
    // Not loaded yet, so it cannot be placed: refresh it rather than risk staleness.
    expect(isQueryAffected(['item', 'item_3'], undefined, moved)).toBe(true);
  });

  it('never refetches meta, and nothing at all when nothing moved', () => {
    expect(isQueryAffected(['meta'], {}, moved)).toBe(false);
    expect(isQueryAffected(['graph', 'a'], {}, quiet)).toBe(false);
    expect(isQueryAffected(['item', 'x'], undefined, quiet)).toBe(false);
  });

  it('keeps job lists fresh while jobs are active, without touching reasoning views', () => {
    expect(isQueryAffected(['jobs', 'b'], [], quiet, true)).toBe(true);
    expect(isQueryAffected(['graph', 'b'], {}, quiet, true)).toBe(false);
    const drained = diffChanges(snapshot({ a: 1 }, 1), snapshot({ a: 1 }, 0));
    expect(isQueryAffected(['jobs', 'a'], [], drained)).toBe(true);
    expect(isQueryAffected(['idea', 'a'], {}, drained)).toBe(false);
    expect(isQueryAffected(['runs', 'a'], [], drained)).toBe(true);
  });
});

describe('liveLabel', () => {
  const base = { status: 'live' as const, activeJobs: 0, lastChangeAt: null, now: 100_000 };
  it('describes the state honestly', () => {
    expect(liveLabel(base).text).toBe('Live');
    expect(liveLabel({ ...base, activeJobs: 2 })).toEqual({
      text: 'Live · 2 jobs running',
      tone: 'busy',
    });
    expect(liveLabel({ ...base, lastChangeAt: 97_000 }).text).toBe('Live · updated just now');
    expect(liveLabel({ ...base, lastChangeAt: 70_000 }).text).toBe('Live · updated 30s ago');
    expect(liveLabel({ ...base, lastChangeAt: 1_000 }).text).toBe('Live');
    expect(liveLabel({ ...base, status: 'offline' }).tone).toBe('off');
  });
});
