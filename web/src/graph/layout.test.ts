import { describe, expect, it } from 'vitest';
import type { GraphDto, ItemDto, RelationDto } from '../../../src/api-types';
import type { RelationType } from '../../../src/domain/vocabulary';
import { layoutGraph } from './layout';

function item(id: string): ItemDto {
  return {
    id,
    ideaId: 'idea_1',
    kind: 'hypothesis',
    origin: 'user',
    status: 'open',
    text: `Item ${id}`,
    epistemicVerdict: null,
    attentionReason: null,
    createdByPass: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revisionCount: 1,
    messageCount: 0,
    productiveDescendantIds: [],
    promotedIdeaId: null,
  };
}

function edge(from: string, type: RelationType, to: string): RelationDto {
  return {
    id: `${from}-${type}-${to}`,
    fromItemId: from,
    toItemId: to,
    type,
    author: 'agent',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function graphOf(ids: string[], edges: RelationDto[]): GraphDto {
  return { ideaId: 'idea_1', nodes: ids.map(item), edges };
}

function yOf(layout: ReturnType<typeof layoutGraph>, id: string): number {
  const node = layout.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no layout for ${id}`);
  return node.y;
}

describe('layoutGraph', () => {
  it('gives every node a finite position and size', () => {
    const layout = layoutGraph(
      graphOf(
        ['root', 'a', 'b', 'lonely'],
        [edge('a', 'derived_from', 'root'), edge('b', 'supports', 'a')],
      ),
    );
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'lonely', 'root']);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
    }
  });

  it('places a derived_from child below its parent (reverse flow)', () => {
    const layout = layoutGraph(
      graphOf(['parent', 'child'], [edge('child', 'derived_from', 'parent')]),
    );
    expect(yOf(layout, 'child')).toBeGreaterThan(yOf(layout, 'parent'));
  });

  it('places a branches_to child below its parent (forward flow)', () => {
    const layout = layoutGraph(
      graphOf(['parent', 'child'], [edge('parent', 'branches_to', 'child')]),
    );
    expect(yOf(layout, 'child')).toBeGreaterThan(yOf(layout, 'parent'));
  });

  it('keeps the semantic direction of edges regardless of layout orientation', () => {
    const layout = layoutGraph(
      graphOf(
        ['root', 'claim', 'branch'],
        [edge('claim', 'derived_from', 'root'), edge('claim', 'branches_to', 'branch')],
      ),
    );
    expect(layout.edges).toEqual([
      { id: 'claim-derived_from-root', source: 'claim', target: 'root', type: 'derived_from' },
      { id: 'claim-branches_to-branch', source: 'claim', target: 'branch', type: 'branches_to' },
    ]);
    expect(yOf(layout, 'root')).toBeLessThan(yOf(layout, 'claim'));
    expect(yOf(layout, 'claim')).toBeLessThan(yOf(layout, 'branch'));
  });

  it('ignores edges whose endpoints are not in the graph and allows parallel edges', () => {
    const layout = layoutGraph(
      graphOf(
        ['a', 'b'],
        [edge('a', 'supports', 'b'), edge('a', 'qualifies', 'b'), edge('a', 'supports', 'gone')],
      ),
    );
    expect(layout.edges.map((e) => e.type)).toEqual(['supports', 'qualifies']);
  });
});
