/**
 * The one live-view poller for the whole app.
 *
 * It asks the cheap change feed (`GET /api/changes`) every couple of seconds while the
 * document is visible, and invalidates exactly the cached queries that belong to ideas whose
 * revision moved (see changes.ts). Components never poll on their own: they read react-query
 * as before and simply re-render when their data is refetched.
 *
 * Hidden tab: no timer runs at all. On becoming visible or focused again, it checks at once.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { ChangesDto } from '../../../src/api-types';
import { api } from '../api';
import { diffChanges, hasChanges, isQueryAffected } from './changes';

export const POLL_INTERVAL_MS = 2_000;
const OFFLINE_INTERVAL_MS = 6_000;
/** How long after a change the header says "updated ...", and therefore keeps ticking. */
const RECENT_MS = 60_000;

export interface LiveState {
  status: 'connecting' | 'live' | 'offline';
  activeJobs: number;
  /** When a change made elsewhere (or a finished job) was last noticed; null if never. */
  lastChangeAt: number | null;
  /** Time of the latest poll. Only advances while something on screen depends on it. */
  now: number;
}

let state: LiveState = { status: 'connecting', activeJobs: 0, lastChangeAt: null, now: Date.now() };
const listeners = new Set<() => void>();

function setState(next: LiveState): void {
  const same =
    next.status === state.status &&
    next.activeJobs === state.activeJobs &&
    next.lastChangeAt === state.lastChangeAt &&
    next.now === state.now;
  if (same) return;
  state = next;
  for (const listener of listeners) listener();
}

export const liveStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): LiveState => state,
};

let checkNow: (() => void) | null = null;

/** Ask the running poller to look right away (e.g. just after queueing a job). */
export function requestLiveCheck(): void {
  checkNow?.();
}

/** Start polling. Returns the function that stops it. Call once, at the app root. */
export function startLivePoller(client: QueryClient): () => void {
  let previous: ChangesDto | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  let stopped = false;

  const visible = () => document.visibilityState === 'visible';

  const schedule = (delay: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (stopped || !visible()) return;
    timer = setTimeout(() => void check(), delay);
  };

  const check = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    let delay = POLL_INTERVAL_MS;
    try {
      const next = await api.getChanges();
      if (stopped) return;
      const diff = diffChanges(previous, next);
      const jobsActive = next.activeJobs > 0 || (previous?.activeJobs ?? 0) > 0;
      previous = next;
      if (hasChanges(diff) || jobsActive) {
        void client.invalidateQueries({
          predicate: (query) => isQueryAffected(query.queryKey, query.state.data, diff, jobsActive),
        });
      }
      const now = Date.now();
      const lastChangeAt = hasChanges(diff) ? now : state.lastChangeAt;
      const ticking =
        next.activeJobs > 0 || (lastChangeAt !== null && now - lastChangeAt < RECENT_MS + 5_000);
      setState({
        status: 'live',
        activeJobs: next.activeJobs,
        lastChangeAt,
        now: ticking ? now : state.now,
      });
    } catch {
      if (stopped) return;
      delay = OFFLINE_INTERVAL_MS;
      setState({ ...state, status: 'offline' });
    } finally {
      inFlight = false;
    }
    if (again) {
      again = false;
      void check();
      return;
    }
    schedule(delay);
  };

  const wake = () => {
    if (!visible()) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = null;
    void check();
  };

  checkNow = wake;
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);
  wake();

  return () => {
    stopped = true;
    checkNow = null;
    if (timer !== null) clearTimeout(timer);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('focus', wake);
    window.removeEventListener('online', wake);
  };
}

/** Header wording for the live indicator. Pure, so it is unit-tested. */
export function liveLabel(live: LiveState): { text: string; tone: 'idle' | 'busy' | 'off' } {
  if (live.status === 'offline') return { text: 'Offline — retrying', tone: 'off' };
  if (live.status === 'connecting') return { text: 'Connecting…', tone: 'idle' };
  if (live.activeJobs > 0) {
    return {
      text:
        live.activeJobs === 1 ? 'Live · 1 job running' : `Live · ${live.activeJobs} jobs running`,
      tone: 'busy',
    };
  }
  if (live.lastChangeAt !== null) {
    const seconds = Math.max(0, Math.round((live.now - live.lastChangeAt) / 1000));
    if (seconds < 10) return { text: 'Live · updated just now', tone: 'busy' };
    if (seconds * 1000 < RECENT_MS) return { text: `Live · updated ${seconds}s ago`, tone: 'idle' };
  }
  return { text: 'Live', tone: 'idle' };
}
