/**
 * Pure helpers that keep the map steady while its data is refreshed by the live view.
 * No React, no DOM: unit-tested in stable.test.ts.
 *
 * The graph is re-laid-out by dagre whenever it changes, and react-query hands us fresh
 * arrays on every refetch. Left alone, that would make React Flow re-render every node and,
 * when an agent adds a node, shift the whole picture under the user's eyes. So:
 *   - `anchorLayout` translates the new layout so a node the user already had on screen
 *     stays exactly where it was;
 *   - `mergeById` re-uses the previous node/edge objects wherever nothing changed, so
 *     React Flow sees identical references and leaves them alone.
 * The viewport (pan/zoom) itself is never touched by a refresh.
 */

export interface Point {
  x: number;
  y: number;
}

interface Positioned extends Point {
  id: string;
}

/**
 * Shift `next` so that what the user was looking at stays put. If `preferredId` (the
 * selected node) exists in both layouts, it keeps its exact position. Otherwise the shift is
 * the one that leaves the most already-placed nodes exactly where they were (dagre usually
 * re-centres a whole row when one node is added, so most nodes share one offset).
 */
export function anchorLayout<T extends Positioned>(
  previous: ReadonlyMap<string, Point>,
  next: readonly T[],
  preferredId: string | null,
): T[] {
  let shift: Point | null = null;
  const preferred = preferredId === null ? undefined : next.find((n) => n.id === preferredId);
  const preferredBefore = preferred ? previous.get(preferred.id) : undefined;
  if (preferred && preferredBefore) {
    shift = { x: preferredBefore.x - preferred.x, y: preferredBefore.y - preferred.y };
  } else {
    const votes = new Map<string, { shift: Point; count: number }>();
    for (const node of next) {
      const before = previous.get(node.id);
      if (!before) continue;
      const candidate = { x: before.x - node.x, y: before.y - node.y };
      const key = `${candidate.x},${candidate.y}`;
      const entry = votes.get(key) ?? { shift: candidate, count: 0 };
      entry.count += 1;
      votes.set(key, entry);
    }
    let best = 0;
    // Insertion order breaks ties, so the earliest node (normally the original idea) wins.
    for (const entry of votes.values()) {
      if (entry.count > best) {
        best = entry.count;
        shift = entry.shift;
      }
    }
  }
  if (shift === null || (shift.x === 0 && shift.y === 0)) return [...next];
  const { x: dx, y: dy } = shift;
  return next.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy }));
}

/**
 * Re-use objects from `previous` when `same(previous, next)` says nothing changed. Returns
 * `previous` itself when the whole list is unchanged, so memoised consumers do no work.
 */
export function mergeById<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
  same: (before: T, after: T) => boolean,
): readonly T[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  let identical = previous.length === next.length;
  const merged = next.map((entry, index) => {
    const before = byId.get(entry.id);
    const kept = before !== undefined && same(before, entry) ? before : entry;
    if (kept !== previous[index]) identical = false;
    return kept;
  });
  return identical ? previous : merged;
}

/** Shallow equality of two plain records; arrays inside are compared element by element. */
export function shallowEqualRecord(a: object, b: object): boolean {
  if (a === b) return true;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const x = left[key];
    const y = right[key];
    if (Array.isArray(x) && Array.isArray(y))
      return x.length === y.length && x.every((value, index) => value === y[index]);
    return x === y;
  });
}

/**
 * Ids that were not known before. `known === null` means "first load": everything is simply
 * the starting point, and nothing counts as newly arrived.
 */
export function newlyArrived(known: ReadonlySet<string> | null, ids: readonly string[]): string[] {
  if (known === null) return [];
  return ids.filter((id) => !known.has(id));
}
