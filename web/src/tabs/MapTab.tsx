import { useMemo, useState } from 'react';
import type { GraphDto, IdeaDto } from '../../../src/api-types';
import { UNRESOLVED_STATUSES } from '../../../src/domain/vocabulary';
import { EmptyState, ErrorNote, Loading } from '../components/Feedback';
import { EDGE_FAMILIES } from '../graph/edgeStyle';
import { IdeaMap } from '../graph/IdeaMap';
import { useOpenItem, useSelectedItemId } from '../itemNavigation';
import { useGraph } from '../queries';

interface MapFilters {
  hideRejected: boolean;
  hideEvidence: boolean;
  onlyUnresolved: boolean;
}

const FILTER_LABELS: Record<keyof MapFilters, string> = {
  hideRejected: 'Hide rejected / superseded',
  hideEvidence: 'Hide evidence',
  onlyUnresolved: 'Show only unresolved',
};

function applyFilters(graph: GraphDto, filters: MapFilters): GraphDto {
  const nodes = graph.nodes.filter((item) => {
    // The original idea is the root of everything; it stays for orientation.
    if (item.kind === 'original_idea') return true;
    if (filters.hideRejected && (item.status === 'rejected' || item.status === 'superseded'))
      return false;
    if (filters.hideEvidence && item.kind === 'evidence') return false;
    if (filters.onlyUnresolved && !UNRESOLVED_STATUSES.includes(item.status)) return false;
    return true;
  });
  const visible = new Set(nodes.map((item) => item.id));
  const edges = graph.edges.filter((e) => visible.has(e.fromItemId) && visible.has(e.toItemId));
  return { ideaId: graph.ideaId, nodes, edges };
}

function Legend() {
  return (
    <div className="map-legend" aria-label="Legend">
      <div className="legend-group">
        <span className="legend-title">Who said it</span>
        <span className="legend-item">
          <i className="swatch origin-user" /> You
        </span>
        <span className="legend-item">
          <i className="swatch origin-extracted_from_user" /> From your words
        </span>
        <span className="legend-item">
          <i className="swatch origin-agent" /> AI
        </span>
      </div>
      <div className="legend-group">
        <span className="legend-title">State</span>
        <span className="legend-item">
          <i className="swatch-box ring" /> Needs you
        </span>
        <span className="legend-item">
          <i className="swatch-box dashed" /> Tangent
        </span>
        <span className="legend-item">
          <i className="swatch-box muted-box" /> Rejected
        </span>
        <span className="legend-item">
          <i className="swatch-box accent" /> Synthesis / conclusion
        </span>
      </div>
      <div className="legend-group">
        <span className="legend-title">Links</span>
        {Object.entries(EDGE_FAMILIES).map(([family, style]) => (
          <span key={family} className="legend-item">
            <i
              className="swatch-line"
              style={{
                borderTopColor: style.color,
                borderTopStyle: style.dashed ? 'dashed' : 'solid',
              }}
            />
            {style.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function MapTab({ idea }: { idea: IdeaDto }) {
  const graph = useGraph(idea.id);
  const openItem = useOpenItem();
  const selectedId = useSelectedItemId();
  const [filters, setFilters] = useState<MapFilters>({
    hideRejected: false,
    hideEvidence: false,
    onlyUnresolved: false,
  });

  const filtered = useMemo(
    () => (graph.data ? applyFilters(graph.data, filters) : null),
    [graph.data, filters],
  );

  if (graph.isPending) return <Loading />;
  if (graph.error) return <ErrorNote error={graph.error} />;
  if (!filtered) return null;

  return (
    <div className="map-tab">
      <div className="map-toolbar">
        {(Object.keys(FILTER_LABELS) as Array<keyof MapFilters>).map((key) => (
          <label key={key} className="check">
            <input
              type="checkbox"
              checked={filters[key]}
              onChange={(e) => setFilters((current) => ({ ...current, [key]: e.target.checked }))}
            />
            {FILTER_LABELS[key]}
          </label>
        ))}
        <span className="muted">
          {filtered.nodes.length} of {graph.data.nodes.length} items · arrows point the way each
          relation reads
        </span>
      </div>
      {filtered.nodes.length <= 1 && graph.data.nodes.length <= 1 ? (
        <EmptyState title="The map has only your original idea so far">
          Run the analysis from the Overview tab to grow it.
        </EmptyState>
      ) : (
        <div className="map-canvas">
          <IdeaMap
            key={JSON.stringify(filters)}
            graph={filtered}
            selectedId={selectedId}
            onSelect={openItem}
          />
        </div>
      )}
      <Legend />
    </div>
  );
}
