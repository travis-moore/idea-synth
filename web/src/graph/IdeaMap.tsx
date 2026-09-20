import { useMemo } from 'react';
import { Background, Controls, MarkerType, MiniMap, ReactFlow } from '@xyflow/react';
import type { Edge, NodeMouseHandler } from '@xyflow/react';
import type { GraphDto, ItemDto } from '../../../src/api-types';
import { RELATION_TYPES } from '../../../src/domain/vocabulary';
import { EDGE_FAMILIES, EDGE_FAMILY } from './edgeStyle';
import { HANDLES, ItemNode } from './ItemNode';
import type { ItemFlowNode } from './ItemNode';
import { layoutGraph } from './layout';

const NODE_TYPES = { item: ItemNode };

const ORIGIN_COLORS: Record<ItemDto['origin'], string> = {
  user: 'var(--c-user)',
  extracted_from_user: 'var(--c-extracted)',
  agent: 'var(--c-agent)',
};

function toFlow(
  graph: GraphDto,
  selectedId: string | null,
): { nodes: ItemFlowNode[]; edges: Edge[] } {
  const layout = layoutGraph(graph);
  const itemsById = new Map(graph.nodes.map((item) => [item.id, item]));
  const yById = new Map(layout.nodes.map((node) => [node.id, node.y]));

  const nodes = layout.nodes.flatMap((placed): ItemFlowNode[] => {
    const item = itemsById.get(placed.id);
    if (!item) return [];
    return [
      {
        id: placed.id,
        type: 'item',
        position: { x: placed.x, y: placed.y },
        width: placed.width,
        height: placed.height,
        data: { item },
        selected: placed.id === selectedId,
      },
    ];
  });

  const edges = layout.edges.map((edge): Edge => {
    const family = EDGE_FAMILIES[EDGE_FAMILY[edge.type]];
    const sourceIsAbove = (yById.get(edge.source) ?? 0) <= (yById.get(edge.target) ?? 0);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: sourceIsAbove ? HANDLES.bottomSource : HANDLES.topSource,
      targetHandle: sourceIsAbove ? HANDLES.topTarget : HANDLES.bottomTarget,
      label: RELATION_TYPES[edge.type].label,
      className: 'map-edge',
      style: {
        stroke: family.color,
        strokeWidth: 1.6,
        strokeDasharray: family.dashed ? '6 4' : undefined,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: family.color, width: 18, height: 18 },
    };
  });
  return { nodes, edges };
}

interface IdeaMapProps {
  graph: GraphDto;
  selectedId: string | null;
  onSelect: (itemId: string) => void;
}

/** The reasoning graph. Read-only: structure changes go through the item panel, not dragging edges. */
export function IdeaMap({ graph, selectedId, onSelect }: IdeaMapProps) {
  const flow = useMemo(() => toFlow(graph, selectedId), [graph, selectedId]);
  const handleNodeClick: NodeMouseHandler<ItemFlowNode> = (_event, node) => onSelect(node.id);

  return (
    <ReactFlow
      nodes={flow.nodes}
      edges={flow.edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={handleNodeClick}
      nodesConnectable={false}
      nodesDraggable={false}
      elementsSelectable
      fitView
      fitViewOptions={{ padding: 0.1, minZoom: 0.5 }}
      minZoom={0.15}
      colorMode="system"
    >
      <Background gap={24} />
      <MiniMap<ItemFlowNode>
        pannable
        zoomable
        nodeColor={(node) => ORIGIN_COLORS[node.data.item.origin]}
        nodeStrokeWidth={0}
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
