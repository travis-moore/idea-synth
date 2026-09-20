import { LIVE_STATUSES } from '../../domain/vocabulary';
import type { IdeaSnapshot, ItemSnapshot } from '../passes';
import type { NewItemOutput } from '../schemas';

export type FixtureLink = {
  type: NewItemOutput['links'][number]['type'];
  to: string;
  direction?: 'out' | 'in';
};
export interface FixtureItem {
  key: string;
  kind: NewItemOutput['kind'];
  text: string;
  links: FixtureLink[];
  needs_user?: boolean;
  attention_reason?: NewItemOutput['attention_reason'];
  is_tangent?: boolean;
  /** Only emit when at least one of these (by run key) is still live. */
  requiresLive?: string[];
}

export const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const isLive = (i: ItemSnapshot) => LIVE_STATUSES.includes(i.status);
export const byRunKey = (s: IdeaSnapshot, key: string) => s.items.find((i) => i.runKey === key);

/**
 * Turn fixture items (which refer to earlier items by run key) into pass output that
 * refers to them by id. Items already present, or whose anchors no longer exist or are
 * no longer live, are dropped, so the mock stays coherent whatever the user decided.
 */
export function resolveFixture(snapshot: IdeaSnapshot, fixture: FixtureItem[]) {
  let candidates = fixture.filter((f) => {
    if (byRunKey(snapshot, f.key)) return false;
    if (!f.requiresLive) return true;
    return f.requiresLive.some((k) => {
      const item = byRunKey(snapshot, k);
      return item !== undefined && isLive(item);
    });
  });

  // Dropping one item can orphan another, so repeat until nothing changes.
  for (;;) {
    const localKeys = new Set(candidates.map((c) => c.key));
    const anchored = candidates.filter(
      (f) =>
        f.links.length === 0 ||
        f.links.some((l) => localKeys.has(l.to) || byRunKey(snapshot, l.to) !== undefined),
    );
    if (anchored.length === candidates.length) break;
    candidates = anchored;
  }

  const localKeys = new Set(candidates.map((c) => c.key));
  return candidates.map(({ requiresLive: _requiresLive, ...item }) => ({
    ...item,
    links: item.links.flatMap((l) => {
      if (localKeys.has(l.to)) return [{ ...l }];
      const target = byRunKey(snapshot, l.to);
      return target ? [{ ...l, to: target.id }] : [];
    }),
  }));
}
