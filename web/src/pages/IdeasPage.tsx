import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { IdeaSummaryDto } from '../../../src/api-types';
import { api } from '../api';
import { EmptyState, ErrorNote, Loading } from '../components/Feedback';
import { SOURCE_LABELS, STAGE_LABELS, truncate } from '../labels';
import { useAction, useIdeas, useViewerMode } from '../queries';

function CaptureForm() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  // A new idea has a one-node graph: start on the overview, where the next step is offered.
  const capture = useAction(
    api.captureIdea,
    (idea) => void navigate(`/ideas/${idea.id}?tab=overview`),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // The text is sent untrimmed on purpose: the original idea is preserved exactly as written.
    capture.mutate({ text, title: title.trim() || undefined });
  };

  return (
    <form className="panel entry-form" onSubmit={submit}>
      <h2>Capture an idea</h2>
      <textarea
        className="idea-input"
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What are you thinking?"
        aria-label="Your idea"
        required
      />
      <p className="hint">
        Write it as you currently understand it. It will be preserved exactly as written.
      </p>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        aria-label="Title (optional)"
      />
      <div className="form-actions">
        <button type="submit" className="primary" disabled={capture.isPending || !text.trim()}>
          {capture.isPending ? 'Capturing…' : 'Capture idea'}
        </button>
      </div>
      <ErrorNote error={capture.error} />
    </form>
  );
}

function GuidedForm() {
  const navigate = useNavigate();
  const [hypothesis, setHypothesis] = useState('');
  const viewer = useViewerMode();
  const start = useAction(api.startGuided, (session) => void navigate(`/guided/${session.id}`));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    start.mutate(hypothesis);
  };

  return (
    <form className="panel entry-form" onSubmit={submit}>
      <h2>Develop a hypothesis with guidance</h2>
      <p className="hint">
        Start from a half-formed hunch. The AI asks questions so that the reasoning stays yours, and
        only offers more help when you are stuck.
      </p>
      {viewer && (
        <p className="viewer-note">
          Viewer mode: your hypothesis is saved here, and the tutor’s questions will be produced by
          your VS Code agent.
        </p>
      )}
      <input
        type="text"
        value={hypothesis}
        onChange={(e) => setHypothesis(e.target.value)}
        placeholder="Maybe…"
        aria-label="Your hypothesis"
        required
      />
      <div className="form-actions">
        <button type="submit" className="primary" disabled={start.isPending || !hypothesis.trim()}>
          {start.isPending ? 'Starting…' : 'Start guided development'}
        </button>
      </div>
      <ErrorNote error={start.error} />
    </form>
  );
}

function ideaPath(idea: IdeaSummaryDto): string {
  return idea.stage === 'guided' && idea.guidedSessionId
    ? `/guided/${idea.guidedSessionId}`
    : `/ideas/${idea.id}`;
}

function IdeaRow({ idea }: { idea: IdeaSummaryDto }) {
  const sourceLabel = SOURCE_LABELS[idea.source];
  return (
    <li>
      <Link to={ideaPath(idea)} className="idea-row">
        <span className="idea-row-main">
          <span className="idea-row-title">{idea.title}</span>
          <span className="idea-row-text">{truncate(idea.originalText, 160)}</span>
        </span>
        <span className="idea-row-chips">
          {sourceLabel && <span className="chip tone-neutral">{sourceLabel}</span>}
          <span className={`badge stage-${idea.stage}`}>{STAGE_LABELS[idea.stage]}</span>
        </span>
        <span className="idea-row-counts">
          <span className={idea.counts.needsUser > 0 ? 'count needs' : 'count'}>
            {idea.counts.needsUser} need you
          </span>
          <span className="count">{idea.counts.open} open</span>
          <span className="count">{idea.counts.tangents} tangents</span>
        </span>
      </Link>
    </li>
  );
}

export function IdeasPage() {
  const ideas = useIdeas();
  return (
    <div className="ideas-page">
      <div className="entry-forms">
        <CaptureForm />
        <GuidedForm />
      </div>
      <section className="ideas-section">
        <h1>Ideas</h1>
        {ideas.isPending && <Loading />}
        <ErrorNote error={ideas.error} />
        {ideas.data?.length === 0 && (
          <EmptyState title="No ideas yet">
            Capture your first idea above, in your own words.
          </EmptyState>
        )}
        {ideas.data && ideas.data.length > 0 && (
          <ul className="idea-list">
            {ideas.data.map((idea) => (
              <IdeaRow key={idea.id} idea={idea} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
