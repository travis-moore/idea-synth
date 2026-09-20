import { Link } from 'react-router-dom';
import type { IdeaDto } from '../../../src/api-types';
import { api } from '../api';
import { ErrorNote } from '../components/Feedback';
import { SynthesizeControl } from '../components/SynthesizeControl';
import { itemInIdeaPath } from '../itemNavigation';
import { truncate } from '../labels';
import { useAction } from '../queries';

interface OverviewTabProps {
  idea: IdeaDto;
  onSelectTab: (tab: 'review' | 'synthesis') => void;
}

function AnalyzeAction({ idea, onSelectTab }: OverviewTabProps) {
  const analyze = useAction(api.analyze, () => onSelectTab('review'));
  return (
    <div className="panel next-action">
      <h2>Next: let the AI map your reasoning</h2>
      <p>
        Four passes extract your claims, explore branches, fact-check and raise objections. Nothing
        is decided for you: everything lands in the Review tab for your judgement.
      </p>
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={analyze.isPending}
          onClick={() => analyze.mutate(idea.id)}
        >
          {analyze.isPending ? 'Running analysis…' : 'Run analysis (Steps 2–5)'}
        </button>
      </div>
      <ErrorNote error={analyze.error} />
    </div>
  );
}

function ReviewGateAction({ idea, onSelectTab }: OverviewTabProps) {
  const { blockingItemIds, openItemIds } = idea.gate;
  return (
    <div className="panel next-action">
      <h2>Next: your review</h2>
      <p className="gate-summary">
        <strong className={blockingItemIds.length > 0 ? 'text-needs' : undefined}>
          {blockingItemIds.length} {blockingItemIds.length === 1 ? 'item needs' : 'items need'} you
        </strong>{' '}
        · {openItemIds.length} still open
      </p>
      <p className="hint">
        Items that need you block the synthesis. Open items do not: they are carried forward as open
        questions.
      </p>
      <div className="form-actions">
        <button type="button" onClick={() => onSelectTab('review')}>
          Go to review
        </button>
      </div>
      <SynthesizeControl
        idea={idea}
        label="Build synthesis (Steps 6–8)"
        onDone={() => onSelectTab('synthesis')}
      />
    </div>
  );
}

function SynthesizedAction({ idea, onSelectTab }: OverviewTabProps) {
  return (
    <div className="panel next-action">
      <h2>Synthesis ready</h2>
      <p>
        Version {idea.latestSynthesisVersion ?? 1} reflects your review decisions. If you change
        them, re-run the synthesis; earlier versions are kept.
      </p>
      <div className="form-actions">
        <button type="button" className="primary" onClick={() => onSelectTab('synthesis')}>
          Open synthesis
        </button>
      </div>
      <SynthesizeControl
        idea={idea}
        label="Re-run synthesis"
        onDone={() => onSelectTab('synthesis')}
      />
    </div>
  );
}

export function OverviewTab({ idea, onSelectTab }: OverviewTabProps) {
  const needsAnalysis = idea.stage === 'captured' || idea.stage === 'guided';
  return (
    <div className="overview">
      <section className="your-words origin-user">
        <h2 className="section-label">Your words — preserved exactly</h2>
        <p className="original-text">{idea.originalText}</p>
        {idea.promotedFrom && (
          <p className="promoted-from">
            Grew from a tangent in{' '}
            <Link to={`/ideas/${idea.promotedFrom.ideaId}`}>«{idea.promotedFrom.ideaTitle}»</Link>:{' '}
            <Link
              to={itemInIdeaPath(idea.promotedFrom.ideaId, idea.promotedFrom.itemId, 'tangents')}
            >
              “{truncate(idea.promotedFrom.itemText, 120)}”
            </Link>
          </p>
        )}
      </section>

      {needsAnalysis && <AnalyzeAction idea={idea} onSelectTab={onSelectTab} />}
      {idea.stage === 'in_review' && <ReviewGateAction idea={idea} onSelectTab={onSelectTab} />}
      {idea.stage === 'synthesized' && <SynthesizedAction idea={idea} onSelectTab={onSelectTab} />}
    </div>
  );
}
