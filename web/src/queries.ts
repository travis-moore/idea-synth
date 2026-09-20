/**
 * react-query wiring: query keys, read hooks, and one mutation helper that refreshes
 * every reasoning view after a write.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { JobDto } from '../../src/api-types';
import { api } from './api';
import type { ApiError } from './api';
import { requestLiveCheck } from './live/poller';

export const keys = {
  meta: ['meta'] as const,
  ideas: ['ideas'] as const,
  idea: (ideaId: string) => ['idea', ideaId] as const,
  graph: (ideaId: string) => ['graph', ideaId] as const,
  runs: (ideaId: string) => ['runs', ideaId] as const,
  events: (ideaId: string) => ['events', ideaId] as const,
  synthesis: (ideaId: string, version: number | undefined) =>
    ['synthesis', ideaId, version ?? 'latest'] as const,
  inbox: ['inbox'] as const,
  openQuestions: ['open-questions'] as const,
  tangents: (ideaId: string | undefined) => ['tangents', ideaId ?? 'all'] as const,
  item: (itemId: string) => ['item', itemId] as const,
  guided: (sessionId: string) => ['guided', sessionId] as const,
  jobs: (ideaId: string) => ['jobs', ideaId] as const,
};

/**
 * One write can touch an item, its neighbours, the graph, the gate, the inbox counts and
 * the synthesis, so every reasoning query is marked stale; only mounted ones refetch.
 */
export function invalidateReasoning(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'meta' });
}

/** A mutation that refreshes all reasoning views when it succeeds. */
export function useAction<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  onDone?: (result: TResult, input: TInput) => void,
) {
  const client = useQueryClient();
  return useMutation<TResult, ApiError, TInput>({
    mutationFn: run,
    onSuccess: async (result, input) => {
      await invalidateReasoning(client);
      // The write may have queued a job: let the live view notice now, not in two seconds.
      requestLiveCheck();
      onDone?.(result, input);
    },
    // A failed write may still have changed something (e.g. your message was saved but the
    // AI reply failed), so refresh then too.
    onError: () => void invalidateReasoning(client),
  });
}

export const useMeta = () =>
  useQuery({ queryKey: keys.meta, queryFn: api.getMeta, staleTime: 60_000 });

/**
 * Whether this page may start reasoning. False in viewer mode (no provider configured for
 * the web UI), and while the answer is still unknown, so that nothing is offered too early.
 */
export function useCanReason(): boolean {
  return useMeta().data?.canReason ?? false;
}

/** True once the server has said it cannot reason for the web UI (never while still unknown). */
export function useViewerMode(): boolean {
  const meta = useMeta().data;
  return meta !== undefined && !meta.canReason;
}

export const useIdeas = () => useQuery({ queryKey: keys.ideas, queryFn: api.listIdeas });
export const useIdea = (ideaId: string) =>
  useQuery({ queryKey: keys.idea(ideaId), queryFn: () => api.getIdea(ideaId) });
export const useGraph = (ideaId: string) =>
  useQuery({ queryKey: keys.graph(ideaId), queryFn: () => api.getGraph(ideaId) });
export const useRuns = (ideaId: string) =>
  useQuery({ queryKey: keys.runs(ideaId), queryFn: () => api.listRuns(ideaId) });
export const useEvents = (ideaId: string) =>
  useQuery({ queryKey: keys.events(ideaId), queryFn: () => api.listEvents(ideaId) });
export const useSynthesis = (ideaId: string, version: number | undefined) =>
  useQuery({
    queryKey: keys.synthesis(ideaId, version),
    queryFn: () => api.getSynthesis(ideaId, version),
  });
export const useInbox = () => useQuery({ queryKey: keys.inbox, queryFn: () => api.listInbox() });
export const useOpenQuestions = () =>
  useQuery({ queryKey: keys.openQuestions, queryFn: () => api.listOpenQuestions() });
export const useTangents = (ideaId?: string) =>
  useQuery({ queryKey: keys.tangents(ideaId), queryFn: () => api.listTangents(ideaId) });
export const useItem = (itemId: string) =>
  useQuery({ queryKey: keys.item(itemId), queryFn: () => api.getItem(itemId) });
export const useGuided = (sessionId: string) =>
  useQuery({ queryKey: keys.guided(sessionId), queryFn: () => api.getGuided(sessionId) });

const ACTIVE_JOB_STATUSES: ReadonlySet<JobDto['status']> = new Set(['queued', 'running']);
export const isActiveJob = (job: JobDto): boolean => ACTIVE_JOB_STATUSES.has(job.status);

/**
 * Recent jobs of one idea, newest first. Not polled here: the live poller refreshes it while
 * any job is active, and this query recovers the state after navigation or a reload.
 */
export const useJobs = (ideaId: string | undefined) =>
  useQuery({
    queryKey: keys.jobs(ideaId ?? ''),
    queryFn: () => api.listJobs(ideaId ?? ''),
    enabled: Boolean(ideaId),
  });
