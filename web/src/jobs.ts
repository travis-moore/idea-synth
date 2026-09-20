/**
 * Pure helpers for showing durable jobs (web-triggered agent work). No React.
 */
import type { JobDto } from '../../src/api-types';

const ACTIVE: ReadonlySet<JobDto['status']> = new Set(['queued', 'running']);
const PROBLEM: ReadonlySet<JobDto['status']> = new Set(['failed', 'cancelled', 'interrupted']);

export interface JobScope {
  /** Only jobs of this guided session (the guided page). */
  sessionId?: string;
  /** Only jobs about this item (the item panel's discussion). */
  itemId?: string;
}

export interface JobsToShow {
  active: JobDto[];
  /**
   * The latest job that did not finish, if nothing newer has taken its place: a failed
   * analysis stops mattering once another analysis was queued after it.
   */
  problem: JobDto | null;
}

const sameWork = (a: JobDto, b: JobDto): boolean =>
  a.kind === b.kind && a.itemId === b.itemId && a.sessionId === b.sessionId;

function inScope(job: JobDto, scope: JobScope): boolean {
  if (scope.sessionId !== undefined && job.sessionId !== scope.sessionId) return false;
  if (scope.itemId !== undefined && job.itemId !== scope.itemId) return false;
  return true;
}

/** `jobs` must be newest first, as the API returns them. */
export function selectJobsToShow(jobs: readonly JobDto[], scope: JobScope = {}): JobsToShow {
  const scoped = jobs.filter((job) => inScope(job, scope));
  const active = scoped.filter((job) => ACTIVE.has(job.status));
  let problem: JobDto | null = null;
  for (const [index, job] of scoped.entries()) {
    if (!PROBLEM.has(job.status)) continue;
    const replaced = scoped.slice(0, index).some((newer) => sameWork(newer, job));
    if (!replaced) problem = job;
    break; // only the most recent unfinished job is worth the user's attention
  }
  return { active, problem };
}

/** "12s", "3m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}h ${two(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${two(seconds)}s`;
  return `${seconds}s`;
}

/** Elapsed running time (or waiting time, for a queued job) at `now`. */
export function jobElapsedMs(job: JobDto, now: number): number {
  const from = Date.parse(job.startedAt ?? job.createdAt);
  const to = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0;
}
