import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { liveStore, startLivePoller } from './poller';
import type { LiveState } from './poller';

/** Mount once at the app root: starts (and on unmount stops) the single poller. */
export function useLivePoller(): void {
  const client = useQueryClient();
  useEffect(() => startLivePoller(client), [client]);
}

export function useLiveState(): LiveState {
  return useSyncExternalStore(liveStore.subscribe, liveStore.getSnapshot);
}
