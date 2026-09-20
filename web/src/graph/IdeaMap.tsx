import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react';
import type { Edge, NodeMouseHandler, Viewport } from '@xyflow/react';
import type { GraphDto, ItemDto } from '../../../src/api-types';
import { RELATION_TYPES } from '../../../src/domain/vocabulary';
import { EDGE_FAMILIES, EDGE_FAMILY } from './edgeStyle';
import { HANDLES, ItemNode } from './ItemNode';
import type { ItemFlowNode } from './ItemNode';
import { layoutGraph } from './layout';
import { anchorLayout, mergeById, shallowEqualRecord } from './stable';
import type { Point } from './stable';

const NODE_TYPES = { item: ItemNode };

const ORIGIN_COLORS: Record<ItemDto['origin'], string> = {
  user: 'var(--c-user)',
  extracted_from_user: 'var(--c-extracted)',
  agent: 'var(--c-agent)',
};

const FIT_OPTIONS = { padding: 0.1, minZoom: 0.5 };

/**
 * Where the user left each idea's map (pan/zoom), for this page's lifetime: switching tabs
 * or opening another page and coming back does not throw the view away.
 */
const savedViewports = new Map<string, Viewport>();

function toFlow(
  graph: GraphDto,
  selectedId: string | null,
  freshIds: ReadonlySet<string>,
  previousPositions: ReadonlyMap<string, Point>,
): { nodes: ItemFlowNode[]; edges: Edge[] } {
  const raw = layoutGraph(graph);
  // Dagre re-ranks everything when a node arrives; keep what the user was looking at in place.
  const layout = {
    nodes: anchorLayout(previousPositions, raw.nodes, selectedId),
    edges: raw.edges,
  };
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
        data: { item, isNew: freshIds.has(placed.id) },
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

function sameNode(before: ItemFlowNode, after: ItemFlowNode): boolean {
  return (
    before.position.x === after.position.x &&
    before.position.y === after.position.y &&
    before.selected === after.selected &&
    before.data.isNew === after.data.isNew &&
    shallowEqualRecord(before.data.item, after.data.item)
  );
}

function sameEdge(before: Edge, after: Edge): boolean {
  return (
    before.source === after.source &&
    before.target === after.target &&
    before.sourceHandle === after.sourceHandle &&
    before.targetHandle === after.targetHandle &&
    before.label === after.label
  );
}

interface MapControlsProps {
  /** Changes when the user changes a filter: an explicit action, so the view is re-fitted. */
  refitKey: string;
  freshIds: ReadonlySet<string>;
}

/** Lives inside <ReactFlow> to reach its instance. The only places the viewport is moved. */
function MapControls({ refitKey, freshIds }: MapControlsProps) {
  const flow = useReactFlow();
  const lastKey = useRef(refitKey);
  useEffect(() => {
    if (lastKey.current === refitKey) return;
    lastKey.current = refitKey;
    // Wait a frame so the filtered nodes are in the store before fitting to them.
    const frame = requestAnimationFrame(() => void flow.fitView(FIT_OPTIONS));
    return () => cancelAnimationFrame(frame);
  }, [refitKey, flow]);

  const fresh = [...freshIds];
  return (
    <>
      <Panel position="top-right" className="map-panel">
        <button type="button" onClick={() => void flow.fitView({ ...FIT_OPTIONS, duration: 300 })}>
          Fit
        </button>
      </Panel>
      {fresh.length > 0 && (
        <Panel position="top-center" className="map-panel">
          <button
            type="button"
            className="map-new-toast"
            onClick={() =>
              void flow.fitView({
                nodes: fresh.map((id) => ({ id })),
                padding: 0.6,
                maxZoom: 1,
                duration: 400,
              })
            }
          >
            {fresh.length === 1 ? '1 new item' : `${fresh.length} new items`} · Show
          </button>
        </Panel>
      )}
    </>
  );
}

interface IdeaMapProps {
  graph: GraphDto;
  selectedId: string | null;
  onSelect: (itemId: string) => void;
  /** Items that arrived while the map was open: they glow briefly. */
  freshIds: ReadonlySet<string>;
  refitKey: string;
}

/**
 * The reasoning graph. Read-only: structure changes go through the item panel, not dragging edges.
 *
 * It is a live view, so data refreshes must not disturb the user: the viewport is fitted only
 * when an idea's map is first opened (or on "Fit" / a filter change), unchanged nodes keep
 * their object identity, and a re-layout is anchored to the node the user has selected.
 * Mount it with `key={ideaId}`.
 */
export function IdeaMap({ graph, selectedId, onSelect, freshIds, refitKey }: IdeaMapProps) {
  const previous = useRef<{ nodes: readonly ItemFlowNode[]; edges: readonly Edge[] }>({
    nodes: [],
    edges: [],
  });
  const flow = useMemo(() => {
    const before = previous.current;
    const positions = new Map(before.nodes.map((node) => [node.id, node.position]));
    const next = toFlow(graph, selectedId, freshIds, positions);
    const merged = {
      nodes: mergeById(before.nodes, next.nodes, sameNode),
      edges: mergeById(before.edges, next.edges, sameEdge),
    };
    previous.current = merged;
    return merged;
  }, [graph, selectedId, freshIds]);
  const handleNodeClick: NodeMouseHandler<ItemFlowNode> = (_event, node) => onSelect(node.id);
  const [savedViewport] = useState(() => savedViewports.get(graph.ideaId));

  return (
    <ReactFlow
      nodes={flow.nodes as ItemFlowNode[]}
      edges={flow.edges as Edge[]}
      nodeTypes={NODE_TYPES}
      onNodeClick={handleNodeClick}
      onMoveEnd={(_event, viewport) => savedViewports.set(graph.ideaId, viewport)}
      nodesConnectable={false}
      nodesDraggable={false}
      elementsSelectable
      // `fitView` only applies when the flow initialises, never on a data refresh.
      fitView={savedViewport === undefined}
      fitViewOptions={FIT_OPTIONS}
      defaultViewport={savedViewport}
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
      <Controls showInteractive={false} position="bottom-left" />
      <MapControls refitKey={refitKey} freshIds={freshIds} />
    </ReactFlow>
  );
}
