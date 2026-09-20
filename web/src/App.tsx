import { NavLink, Route, Routes } from 'react-router-dom';
import { EmptyState } from './components/Feedback';
import { ItemDrawer } from './item/ItemDrawer';
import { GuidedPage } from './pages/GuidedPage';
import { IdeasPage } from './pages/IdeasPage';
import { IdeaWorkspace } from './pages/IdeaWorkspace';
import { ItemPage } from './pages/ItemPage';
import { InboxPage, OpenQuestionsPage, TangentLibraryPage } from './pages/WorkspaceLists';
import { liveLabel } from './live/poller';
import { useLivePoller, useLiveState } from './live/useLive';
import { useInbox, useMeta } from './queries';

/**
 * Says honestly where reasoning happens. Viewer mode is the normal case: the user talks to a
 * coding agent in VS Code, and this page is a live view of the shared state.
 */
function ModeBanner() {
  const meta = useMeta();
  if (!meta.data) return null;
  const { canReason, live, provider, providerStatus } = meta.data;
  if (!canReason) {
    return (
      <div className="mode-banner viewer" role="status">
        <strong>Viewer mode</strong> — reasoning happens in your VS Code agent
        <span className="nav-long">
          {' '}
          (Claude Code or Codex) through the <code>synth</code> CLI
        </span>
        . This page updates live.
      </div>
    );
  }
  if (!live) {
    return (
      <div className="mode-banner demo" role="status">
        Demo mode — AI responses are deterministic mock data
        <span className="nav-long"> (provider: {provider})</span>
      </div>
    );
  }
  return (
    <div className="mode-banner reasoning" role="status">
      Web reasoning: {providerStatus}
    </div>
  );
}

function LiveIndicator() {
  const live = useLiveState();
  const label = liveLabel(live);
  return (
    <span
      className={`live-indicator live-${label.tone}`}
      role="status"
      title="This page follows changes made anywhere — here, or by your coding agent through the CLI."
    >
      <span className="live-dot" aria-hidden="true" />
      <span className="live-text">{label.text}</span>
    </span>
  );
}

function TopNav() {
  const inbox = useInbox();
  const count = inbox.data?.length ?? 0;
  return (
    <header className="top-nav">
      <NavLink to="/" className="brand" end>
        Idea Synth
      </NavLink>
      {/* One nav: a row in the header on wide screens, a bottom tab bar on phones (CSS). */}
      <nav aria-label="Main" className="main-nav">
        <NavLink to="/" end>
          Ideas
        </NavLink>
        <NavLink to="/inbox">
          Inbox
          {count > 0 && (
            <span className="count-badge" title={`${count} items need you`}>
              {count}
            </span>
          )}
        </NavLink>
        <NavLink to="/open-questions">
          <span className="nav-long">Open </span>Questions
        </NavLink>
        <NavLink to="/tangents">
          Tangent<span className="nav-long"> Library</span>
          <span className="nav-short">s</span>
        </NavLink>
      </nav>
      <LiveIndicator />
    </header>
  );
}

export function App() {
  useLivePoller();
  return (
    <div className="app">
      <ModeBanner />
      <TopNav />
      <main className="page">
        <Routes>
          <Route path="/" element={<IdeasPage />} />
          <Route path="/ideas/:ideaId" element={<IdeaWorkspace />} />
          <Route path="/items/:itemId" element={<ItemPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/open-questions" element={<OpenQuestionsPage />} />
          <Route path="/tangents" element={<TangentLibraryPage />} />
          <Route path="/guided/:sessionId" element={<GuidedPage />} />
          <Route
            path="*"
            element={
              <EmptyState title="Page not found">There is nothing at this address.</EmptyState>
            }
          />
        </Routes>
      </main>
      <ItemDrawer />
    </div>
  );
}
