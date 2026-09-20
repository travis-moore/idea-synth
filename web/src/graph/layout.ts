/**
 * Pure layout for the reasoning map: no React, no DOM.
 *
 * Dagre ranks nodes top-to-bottom in the order thoughts arose, so each edge is fed to it
 * oriented by `RELATION_TYPES[type].flow`. The returned edges keep their true semantic
 * direction (from -> to); only the ranking uses the chronological orientation.
 */
import dagre from '@dagrejs/dagre';
import type { GraphDto } from '../../../src/api-types';
import { RELATION_TYPES } from '../../../src/domain/vocabulary';
import type { RelationType } from '../../../src/domain/vocabulary';

export const NODE_WIDTH = 250;
export const NODE_HEIGHT = 112;

export interface LaidOutNode {
  id: string;
  /** Top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutEdge {
  id: string;
  /** Semantic direction: source --type--> target. */
  source: string;
  target: string;
  type: RelationType;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

export function layoutGraph(graph: GraphDto): GraphLayout {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 72, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const known = new Set(graph.nodes.map((n) => n.id));
  const edges: LaidOutEdge[] = [];
  for (const edge of graph.edges) {
    if (!known.has(edge.fromItemId) || !known.has(edge.toItemId)) continue;
    if (edge.fromItemId === edge.toItemId) continue;
    const meta = RELATION_TYPES[edge.type];
    const [earlier, later] =
      meta.flow === 'forward' ? [edge.fromItemId, edge.toItemId] : [edge.toItemId, edge.fromItemId];
    // Genealogy shapes the tree; cross-links should bend around it rather than reshape it.
    g.setEdge(earlier, later, { weight: meta.genealogical ? 3 : 1 }, edge.id);
    edges.push({ id: edge.id, source: edge.fromItemId, target: edge.toItemId, type: edge.type });
  }

  dagre.layout(g);

  const nodes = graph.nodes.map((node): LaidOutNode => {
    const placed = g.node(node.id);
    return {
      id: node.id,
      x: placed.x - NODE_WIDTH / 2,
      y: placed.y - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  return { nodes, edges };
}
