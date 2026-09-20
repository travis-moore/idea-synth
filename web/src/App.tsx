import { NavLink, Route, Routes } from 'react-router-dom';
import { EmptyState } from './components/Feedback';
import { ItemDrawer } from './item/ItemDrawer';
import { GuidedPage } from './pages/GuidedPage';
import { IdeasPage } from './pages/IdeasPage';
import { IdeaWorkspace } from './pages/IdeaWorkspace';
import { ItemPage } from './pages/ItemPage';
import { InboxPage, OpenQuestionsPage, TangentLibraryPage } from './pages/WorkspaceLists';
import { useInbox, useMeta } from './queries';

function DemoBanner() {
  const meta = useMeta();
  if (!meta.data || meta.data.live) return null;
  return (
    <div className="demo-banner" role="status">
      Demo mode — AI responses are deterministic mock data (provider: {meta.data.provider})
    </div>
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
      <nav aria-label="Main">
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
        <NavLink to="/open-questions">Open Questions</NavLink>
        <NavLink to="/tangents">Tangent Library</NavLink>
      </nav>
    </header>
  );
}

export function App() {
  return (
    <div className="app">
      <DemoBanner />
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
