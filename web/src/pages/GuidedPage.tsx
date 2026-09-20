import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { GuidedSessionDto, GuidedStepDto } from '../../../src/api-types';
import { SCAFFOLD_LEVELS } from '../../../src/domain/scaffolding';
import type { PremiseStance, ScaffoldLevel } from '../../../src/domain/scaffolding';
import { api } from '../api';
import { ToneChip } from '../components/Badges';
import { EmptyState, ErrorNote, Loading } from '../components/Feedback';
import { itemInIdeaPath } from '../itemNavigation';
import { ADEQUACY_LABELS, ADEQUACY_TONES, AUTHOR_LABELS, STANCE_LABELS } from '../labels';
import { useAction, useGuided } from '../queries';

const LEVELS: readonly ScaffoldLevel[] = [1, 2, 3, 4, 5];

function isScaffoldLevel(value: number | null): value is ScaffoldLevel {
  return LEVELS.some((level) => level === value);
}

function LevelChip({ level }: { level: number | null }) {
  if (!isScaffoldLevel(level)) return null;
  const meta = SCAFFOLD_LEVELS[level];
  return (
    <span className={`chip level-chip level-${level}`} title={meta.description}>
      L{level} {meta.name}
    </span>
  );
}

function LevelMeter({ level }: { level: number }) {
  return (
    <div className="level-meter panel">
      <div className="level-meter-head">
        <span className="section-label">Level of help</span>
        {isScaffoldLevel(level) && <strong>{SCAFFOLD_LEVELS[level].name}</strong>}
      </div>
      <ol className="level-steps" aria-label={`Scaffolding level ${level} of 5`}>
        {LEVELS.map((step) => (
          <li
            key={step}
            className={step <= level ? 'level-step filled' : 'level-step'}
            aria-current={step === level ? 'step' : undefined}
            title={`L${step} ${SCAFFOLD_LEVELS[step].name} — ${SCAFFOLD_LEVELS[step].description}`}
          >
            {step}
          </li>
        ))}
      </ol>
      <p className="hint">Help increases only when you're stuck.</p>
    </div>
  );
}

const STEP_TITLES: Record<GuidedStepDto['stepKind'], string> = {
  question: 'Question',
  options: 'Possibilities to evaluate',
  teaching: 'Background from the AI',
  feedback: 'Feedback',
  answer: 'Your answer',
  supplied_premise: 'AI-supplied premise — not your idea unless you accept it',
  premise_response: 'Your response to the premise',
};

interface PremiseActionsProps {
  sessionId: string;
}

function PremiseActions({ sessionId }: PremiseActionsProps) {
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState('');
  const respond = useAction((body: { stance: PremiseStance; body?: string }) =>
    api.respondToPremise(sessionId, body),
  );

  return (
    <div className="premise-actions">
      <div className="form-actions">
        <button
          type="button"
          className="decide-accept"
          disabled={respond.isPending}
          onClick={() => respond.mutate({ stance: 'accept' })}
        >
          Accept
        </button>
        <button
          type="button"
          className="decide-reject"
          disabled={respond.isPending}
          onClick={() => respond.mutate({ stance: 'reject' })}
        >
          Reject
        </button>
        <button
          type="button"
          aria-expanded={changing}
          disabled={respond.isPending}
          onClick={() => setChanging((open) => !open)}
        >
          Change it…
        </button>
      </div>
      {changing && (
        <div className="inline-form">
          <label>
            Say it the way you would put it
            <textarea rows={3} value={changed} onChange={(e) => setChanged(e.target.value)} />
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="primary"
              disabled={respond.isPending || !changed.trim()}
              onClick={() => respond.mutate({ stance: 'modify', body: changed.trim() })}
            >
              Use my version
            </button>
          </div>
        </div>
      )}
      <ErrorNote error={respond.error} />
    </div>
  );
}

interface StepProps {
  step: GuidedStepDto;
  session: GuidedSessionDto;
  /** True for the supplied premise that is currently waiting for a response. */
  awaitingResponse: boolean;
  onPickOption: (option: string) => void;
}

function Step({ step, session, awaitingResponse, onPickOption }: StepProps) {
  return (
    <li className={`guided-step author-${step.author} kind-${step.stepKind}`}>
      <div className="guided-step-head">
        <span className={`badge actor-${step.author}`}>{AUTHOR_LABELS[step.author]}</span>
        <span className="guided-step-title">{STEP_TITLES[step.stepKind]}</span>
        {step.author === 'agent' && <LevelChip level={step.level} />}
        {step.adequacy && (
          <ToneChip
            tone={ADEQUACY_TONES[step.adequacy]}
            title="How far this answer moved the reasoning along"
          >
            {ADEQUACY_LABELS[step.adequacy]}
          </ToneChip>
        )}
        {step.stance && <span className="chip tone-neutral">{STANCE_LABELS[step.stance]}</span>}
        {step.itemId && (
          <Link to={itemInIdeaPath(session.ideaId, step.itemId, 'map')} className="small-link">
            in graph
          </Link>
        )}
      </div>
      {step.body && <p className="guided-step-body">{step.body}</p>}
      {step.options && step.options.length > 0 && (
        <ul className="guided-options">
          {step.options.map((option) => (
            <li key={option}>
              <button
                type="button"
                onClick={() => onPickOption(option)}
                title="Copy into the answer box"
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      )}
      {awaitingResponse && <PremiseActions sessionId={session.id} />}
    </li>
  );
}

function AnswerBox({
  session,
  draft,
  onDraft,
}: {
  session: GuidedSessionDto;
  draft: string;
  onDraft: (value: string) => void;
}) {
  const reply = useAction(
    (body: string) => api.replyGuided(session.id, body),
    () => onDraft(''),
  );
  const resume = useAction(() => api.continueGuided(session.id));
  const blocked = session.awaitingPremiseResponse || session.awaitingTutor;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    reply.mutate(draft);
  };

  return (
    <form className="panel answer-box" onSubmit={submit}>
      {session.awaitingTutor && (
        <div className="notice">
          <p>The AI's next move did not arrive. Your answer is saved.</p>
          <button
            type="button"
            className="primary"
            disabled={resume.isPending}
            onClick={() => resume.mutate(undefined)}
          >
            {resume.isPending ? 'Continuing…' : 'Continue'}
          </button>
          <ErrorNote error={resume.error} />
        </div>
      )}
      <label>
        <span className="section-label">Your answer</span>
        <textarea
          rows={4}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          disabled={blocked}
          placeholder={
            session.awaitingPremiseResponse
              ? 'Respond to the AI-supplied premise above first.'
              : 'Think out loud…'
          }
        />
      </label>
      <p className="hint">"I don't know" is a fine answer.</p>
      <div className="form-actions">
        <button
          type="submit"
          className="primary"
          disabled={blocked || reply.isPending || !draft.trim()}
        >
          {reply.isPending ? 'Sending…' : 'Answer'}
        </button>
      </div>
      <ErrorNote error={reply.error} />
    </form>
  );
}

function Handoff({ session }: { session: GuidedSessionDto }) {
  const navigate = useNavigate();
  const handoff = useAction(
    () => api.handOffGuided(session.id),
    (idea) => void navigate(`/ideas/${idea.id}`),
  );
  const hasAnswer = session.steps.some((step) => step.stepKind === 'answer');

  if (session.status === 'handed_off') {
    return (
      <div className="panel handoff">
        <p>This session has been taken into synthesis.</p>
        <Link to={`/ideas/${session.ideaId}`} className="button-link primary">
          Open the idea
        </Link>
      </div>
    );
  }
  if (session.status !== 'finished' && !hasAnswer) return null;
  return (
    <div className="panel handoff">
      <p>
        {session.status === 'finished'
          ? 'You have developed this as far as the guided questions go.'
          : 'You can keep answering, or take what you have so far into the full analysis and review.'}
      </p>
      <button
        type="button"
        className="primary"
        disabled={handoff.isPending}
        onClick={() => handoff.mutate(undefined)}
      >
        {handoff.isPending ? 'Handing off…' : 'Take this into synthesis'}
      </button>
      <ErrorNote error={handoff.error} />
    </div>
  );
}

/** Guided Idea Development: a structured transcript with an explicit level of help, not a chat. */
export function GuidedPage() {
  const { sessionId = '' } = useParams();
  const session = useGuided(sessionId);
  const [draft, setDraft] = useState('');

  if (session.isPending) return <Loading />;
  if (session.error) {
    return (
      <EmptyState title="Could not open this guided session">
        <ErrorNote error={session.error} />
      </EmptyState>
    );
  }

  const data = session.data;
  const pendingPremiseId = data.awaitingPremiseResponse
    ? data.steps.findLast((step) => step.stepKind === 'supplied_premise')?.id
    : undefined;

  return (
    <div className="guided">
      <div className="guided-main">
        <section className="your-words origin-user">
          <h1 className="section-label">Your hypothesis</h1>
          <p className="original-text">{data.hypothesis}</p>
        </section>

        <ol className="guided-steps">
          {data.steps.map((step) => (
            <Step
              key={step.id}
              step={step}
              session={data}
              awaitingResponse={step.id === pendingPremiseId}
              onPickOption={setDraft}
            />
          ))}
        </ol>

        {data.status === 'active' && <AnswerBox session={data} draft={draft} onDraft={setDraft} />}
      </div>

      <aside className="guided-side">
        <LevelMeter level={data.level} />
        <Handoff session={data} />
        <p className="hint">
          Every answer you give is recorded as yours. Anything the AI supplies stays labelled as the
          AI's unless you accept it.
        </p>
      </aside>
    </div>
  );
}
