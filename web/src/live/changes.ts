/**
 * Pure logic of the live view: compare two snapshots of the change feed (`GET /api/changes`)
 * and decide which cached queries are out of date. No React, no DOM, no network.
 *
 * The web client is mainly a live view of state that a coding agent changes through the
 * CLI, so this runs every couple of seconds. It must therefore be precise: only queries
 * that belong to an idea whose revision moved are refetched, and nothing else is touched.
 */
import type { ChangesDto } from '../../../src/api-types';

export interface ChangeDiff {
  /** Ideas whose revision moved, plus ideas that appeared or disappeared. */
  changedIdeaIds: string[];
  /** True when the set of ideas itself changed (the Ideas list needs a refetch). */
  ideaSetChanged: boolean;
  /** True when the number of active jobs changed. */
  jobsChanged: boolean;
}

export const NO_CHANGES: ChangeDiff = {
  changedIdeaIds: [],
  ideaSetChanged: false,
  jobsChanged: false,
};

/**
 * What moved between two polls. The first snapshot (`previous === null`) is only a
 * baseline: the queries on screen were fetched just now, so nothing is invalidated.
 */
export function diffChanges(previous: ChangesDto | null, next: ChangesDto): ChangeDiff {
  if (previous === null) return NO_CHANGES;
  const changed: string[] = [];
  let ideaSetChanged = false;
  for (const [ideaId, revision] of Object.entries(next.ideas)) {
    const before = previous.ideas[ideaId];
    if (before === undefined) ideaSetChanged = true;
    if (before !== revision) changed.push(ideaId);
  }
  for (const ideaId of Object.keys(previous.ideas)) {
    if (next.ideas[ideaId] === undefined) {
      ideaSetChanged = true;
      changed.push(ideaId);
    }
  }
  return {
    changedIdeaIds: changed,
    ideaSetChanged,
    jobsChanged: previous.activeJobs !== next.activeJobs,
  };
}

export function hasChanges(diff: ChangeDiff): boolean {
  return diff.changedIdeaIds.length > 0 || diff.ideaSetChanged || diff.jobsChanged;
}

/** Query kinds whose key is `[kind, ideaId, ...]`. */
const IDEA_SCOPED = new Set(['idea', 'graph', 'runs', 'events', 'synthesis']);
/** Cross-idea lists: any idea moving can change them. */
const WORKSPACE_LISTS = new Set(['ideas', 'inbox', 'open-questions']);

function ideaIdInData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  // GuidedSessionDto carries `ideaId`; ItemDetailDto carries `idea.id`.
  const direct = (data as { ideaId?: unknown }).ideaId;
  if (typeof direct === 'string') return direct;
  const idea = (data as { idea?: unknown }).idea;
  if (typeof idea === 'object' && idea !== null) {
    const nested = (idea as { id?: unknown }).id;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

/**
 * Should this cached query be refetched, given what moved?
 *
 * `data` is the query's current cached data: item and guided-session queries are keyed by
 * their own id, so the idea they belong to is read from what was fetched. A query with no
 * data yet cannot be placed, so it is refreshed whenever anything moved (cheap, and safe).
 *
 * `jobsActive` is true while any job is queued or running: a job's status and progress text
 * change without touching an idea's revision, so job lists are refreshed on every poll
 * until the queue drains.
 */
export function isQueryAffected(
  queryKey: readonly unknown[],
  data: unknown,
  diff: ChangeDiff,
  jobsActive = false,
): boolean {
  const kind = queryKey[0];
  if (typeof kind !== 'string' || kind === 'meta') return false;
  const changed = diff.changedIdeaIds;
  const scope = queryKey[1];

  if (kind === 'jobs') {
    if (jobsActive || diff.jobsChanged) return true;
    return typeof scope === 'string' && changed.includes(scope);
  }
  // A job that failed leaves a `failed` run behind without moving the idea's revision.
  if (kind === 'runs' && diff.jobsChanged) return true;
  if (changed.length === 0 && !diff.ideaSetChanged) return false;

  if (WORKSPACE_LISTS.has(kind)) return true;
  if (IDEA_SCOPED.has(kind)) return typeof scope === 'string' && changed.includes(scope);
  if (kind === 'tangents')
    return scope === 'all' || (typeof scope === 'string' && changed.includes(scope));
  if (kind === 'item' || kind === 'guided') {
    const ideaId = ideaIdInData(data);
    return ideaId === null ? true : changed.includes(ideaId);
  }
  // An unknown query kind: refresh rather than risk showing stale reasoning.
  return true;
}
