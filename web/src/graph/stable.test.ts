import { describe, expect, it } from 'vitest';
import { anchorLayout, mergeById, newlyArrived, shallowEqualRecord } from './stable';

describe('anchorLayout', () => {
  const previous = new Map([
    ['root', { x: 100, y: 0 }],
    ['a', { x: 0, y: 200 }],
  ]);

  it('keeps the preferred (selected) node where it was and shifts the rest with it', () => {
    const next = [
      { id: 'root', x: 250, y: 0 },
      { id: 'a', x: 0, y: 200 },
      { id: 'new', x: 300, y: 200 },
    ];
    const placed = anchorLayout(previous, next, 'root');
    expect(placed.find((n) => n.id === 'root')).toMatchObject({ x: 100, y: 0 });
    expect(placed.find((n) => n.id === 'new')).toMatchObject({ x: 150, y: 200 });
  });

  it('falls back to the first already-placed node when the preferred one is unknown', () => {
    const next = [
      { id: 'brand-new', x: 0, y: 0 },
      { id: 'a', x: 40, y: 260 },
    ];
    const placed = anchorLayout(previous, next, 'brand-new');
    expect(placed.find((n) => n.id === 'a')).toMatchObject({ x: 0, y: 200 });
    expect(placed.find((n) => n.id === 'brand-new')).toMatchObject({ x: -40, y: -60 });
  });

  it('without a selection, keeps as many nodes as possible exactly where they were', () => {
    const before = new Map([
      ['root', { x: 100, y: 0 }],
      ['a', { x: 0, y: 200 }],
      ['b', { x: 300, y: 200 }],
      ['c', { x: 600, y: 200 }],
    ]);
    // Dagre re-centred the row (a, b, c all +50) but left the root alone.
    const next = [
      { id: 'root', x: 100, y: 0 },
      { id: 'a', x: 50, y: 200 },
      { id: 'b', x: 350, y: 200 },
      { id: 'c', x: 650, y: 200 },
      { id: 'new', x: 950, y: 200 },
    ];
    const placed = anchorLayout(before, next, null);
    expect(placed.filter((n) => before.get(n.id)?.x === n.x)).toHaveLength(3);
    expect(placed.find((n) => n.id === 'root')).toMatchObject({ x: 50 });
    expect(placed.find((n) => n.id === 'new')).toMatchObject({ x: 900 });
  });

  it('leaves a first layout alone', () => {
    const next = [{ id: 'root', x: 5, y: 6 }];
    expect(anchorLayout(new Map(), next, null)).toEqual(next);
  });
});

describe('mergeById', () => {
  const same = (a: { id: string; v: number }, b: { id: string; v: number }) => a.v === b.v;

  it('returns the previous array itself when nothing changed', () => {
    const previous = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ];
    const next = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ];
    expect(mergeById(previous, next, same)).toBe(previous);
  });

  it('keeps the identity of unchanged entries and takes changed and new ones', () => {
    const previous = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ];
    const next = [
      { id: 'a', v: 1 },
      { id: 'b', v: 3 },
      { id: 'c', v: 4 },
    ];
    const merged = mergeById(previous, next, same);
    expect(merged[0]).toBe(previous[0]);
    expect(merged[1]).toBe(next[1]);
    expect(merged[2]).toBe(next[2]);
  });

  it('notices removals and reordering', () => {
    const previous = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ];
    expect(mergeById(previous, [{ id: 'a', v: 1 }], same)).not.toBe(previous);
    const reordered = mergeById(previous, [previous[1]!, previous[0]!], same);
    expect(reordered).not.toBe(previous);
    expect(reordered[0]).toBe(previous[1]);
  });
});

describe('shallowEqualRecord', () => {
  it('compares arrays by element', () => {
    expect(shallowEqualRecord({ a: 1, ids: ['x'] }, { a: 1, ids: ['x'] })).toBe(true);
    expect(shallowEqualRecord({ a: 1, ids: ['x'] }, { a: 1, ids: ['y'] })).toBe(false);
    expect(shallowEqualRecord({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('newlyArrived', () => {
  it('treats the first load as the baseline, not as news', () => {
    expect(newlyArrived(null, ['a', 'b'])).toEqual([]);
  });
  it('reports only ids that were not known', () => {
    expect(newlyArrived(new Set(['a']), ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });
});
