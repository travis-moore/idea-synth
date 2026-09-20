import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphDto, IdeaDto } from '../../../src/api-types';
import { UNRESOLVED_STATUSES } from '../../../src/domain/vocabulary';
import { EmptyState, ErrorNote, Loading } from '../components/Feedback';
import { EDGE_FAMILIES } from '../graph/edgeStyle';
import { IdeaMap } from '../graph/IdeaMap';
import { newlyArrived } from '../graph/stable';
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

const HIGHLIGHT_MS = 3_000;
const NO_FRESH: ReadonlySet<string> = new Set();

/**
 * Ids of items that arrived while this map was open, for a few seconds each. Tracked on the
 * unfiltered graph, so toggling a filter never makes old items look new.
 */
function useFreshItemIds(graph: GraphDto | undefined): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NO_FRESH);

  useEffect(() => {
    if (!graph) return;
    const ids = graph.nodes.map((node) => node.id);
    const added = newlyArrived(known.current, ids);
    known.current = new Set(ids);
    if (added.length === 0) return;
    setFresh((current) => new Set([...current, ...added]));
    const pending = timers.current;
    const timer = setTimeout(() => {
      pending.delete(timer);
      setFresh((current) => {
        const next = new Set(current);
        for (const id of added) next.delete(id);
        return next.size === 0 ? NO_FRESH : next;
      });
    }, HIGHLIGHT_MS);
    pending.add(timer);
  }, [graph]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  return fresh;
}

export function MapTab({ idea }: { idea: IdeaDto }) {
  const graph = useGraph(idea.id);
  const openItem = useOpenItem();
  const selectedId = useSelectedItemId();
  const freshIds = useFreshItemIds(graph.data);
  // On a phone the canvas gets the screen: legend and filters wait behind a toggle (the
  // stylesheet always shows them on wide screens, where the toggle itself is hidden).
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [filters, setFilters] = useState<MapFilters>({
    hideRejected: false,
    hideEvidence: false,
    onlyUnresolved: false,
  });

  const filtered = useMemo(
    () => (graph.data ? applyFilters(graph.data, filters) : null),
    [graph.data, filters],
  );

  // A failed background refresh keeps the map on screen.
  if (!graph.data || !filtered)
    return graph.error ? <ErrorNote error={graph.error} /> : <Loading />;

  const activeFilters = Object.values(filters).filter(Boolean).length;
  return (
    <div className={optionsOpen ? 'map-tab options-open' : 'map-tab'}>
      <div className="map-toolbar">
        <button
          type="button"
          className="map-options-toggle"
          aria-expanded={optionsOpen}
          onClick={() => setOptionsOpen((open) => !open)}
        >
          Legend / Filters{activeFilters > 0 ? ` (${activeFilters} on)` : ''}
        </button>
        <div className="map-filters">
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
        </div>
        <span className="muted map-count">
          {filtered.nodes.length} of {graph.data.nodes.length} items
          <span className="map-count-long"> · arrows point the way each relation reads</span>
        </span>
      </div>
      {graph.data.nodes.length <= 1 ? (
        <EmptyState title="The map has only your original idea so far">
          It grows as the idea is analysed — from the Overview tab, or by your coding agent. New
          items appear here on their own.
        </EmptyState>
      ) : (
        <div className="map-canvas">
          <IdeaMap
            key={idea.id}
            graph={filtered}
            selectedId={selectedId}
            onSelect={openItem}
            freshIds={freshIds}
            refitKey={JSON.stringify(filters)}
          />
        </div>
      )}
      <Legend />
    </div>
  );
}
