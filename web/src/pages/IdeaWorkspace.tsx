import { Link, useParams, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorNote, Loading } from '../components/Feedback';
import { JobStrip } from '../components/JobStrip';
import { Stepper } from '../components/Stepper';
import { SOURCE_LABELS, STAGE_LABELS } from '../labels';
import { useIdea } from '../queries';
import { HistoryTab } from '../tabs/HistoryTab';
import { MapTab } from '../tabs/MapTab';
import { OverviewTab } from '../tabs/OverviewTab';
import { ReviewTab } from '../tabs/ReviewTab';
import { SynthesisTab } from '../tabs/SynthesisTab';
import { TangentsTab } from '../tabs/TangentsTab';

// The map comes first: the workspace is primarily a live view of the reasoning graph.
const TABS = [
  { id: 'map', label: 'Map' },
  { id: 'overview', label: 'Overview' },
  { id: 'review', label: 'Review' },
  { id: 'synthesis', label: 'Synthesis' },
  { id: 'tangents', label: 'Tangents' },
  { id: 'history', label: 'History' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function isTabId(value: string | null): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

export function IdeaWorkspace() {
  const { ideaId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const idea = useIdea(ideaId);

  const rawTab = params.get('tab');
  const activeTab: TabId = isTabId(rawTab) ? rawTab : 'map';
  const selectTab = (tab: TabId) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('tab', tab);
      next.delete('version');
      return next;
    });
  };

  // A failed background refresh must not tear down what the user is looking at.
  const data = idea.data;
  if (!data) {
    if (!idea.error) return <Loading />;
    return (
      <EmptyState title="Could not open this idea">
        <ErrorNote error={idea.error} />
      </EmptyState>
    );
  }

  const sourceLabel = SOURCE_LABELS[data.source];
  return (
    <>
      <header className="workspace-header">
        <div className="workspace-title">
          <h1>{data.title}</h1>
          <span className={`badge stage-${data.stage}`}>{STAGE_LABELS[data.stage]}</span>
          {sourceLabel && <span className="chip tone-neutral">{sourceLabel}</span>}
          {data.guidedSessionId && (
            <Link to={`/guided/${data.guidedSessionId}`} className="small-link">
              Guided session
            </Link>
          )}
        </div>
        <Stepper stage={data.stage} />
        <JobStrip ideaId={data.id} />
      </header>

      <div className="tabs" role="tablist" aria-label="Idea views">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            className={tab.id === activeTab ? 'tab active' : 'tab'}
            onClick={() => selectTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'review' && data.counts.needsUser > 0 && (
              <span className="count-badge">{data.counts.needsUser}</span>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {activeTab === 'overview' && <OverviewTab idea={data} onSelectTab={selectTab} />}
        {activeTab === 'review' && <ReviewTab idea={data} />}
        {activeTab === 'map' && <MapTab idea={data} />}
        {activeTab === 'synthesis' && <SynthesisTab idea={data} />}
        {activeTab === 'tangents' && <TangentsTab idea={data} />}
        {activeTab === 'history' && <HistoryTab idea={data} />}
      </div>
    </>
  );
}
