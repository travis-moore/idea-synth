import { useState } from 'react';
import type { ItemDto } from '../../../src/api-types';
import type { DecisionType, ItemStatus } from '../../../src/domain/vocabulary';
import { api } from '../api';
import type { DecisionInput } from '../api';
import { ErrorNote } from '../components/Feedback';
import { ACCEPTED_HINT } from '../labels';
import { useAction } from '../queries';
import { PanelSection } from './PanelParts';

interface Choice {
  decision: DecisionType;
  label: string;
  /** The status this decision leads to; the button is disabled when the item is already there. */
  target: ItemStatus;
  className: string;
  title?: string;
}

const ACCEPT: Choice = {
  decision: 'accept',
  label: 'Accept',
  target: 'accepted',
  className: 'decide-accept',
  title: ACCEPTED_HINT,
};

/** Shown after the two accept buttons. */
const OTHER_CHOICES: readonly Choice[] = [
  { decision: 'reject', label: 'Reject', target: 'rejected', className: 'decide-reject' },
  {
    decision: 'mark_tangent',
    label: 'Set aside as tangent',
    target: 'tangent',
    className: 'decide-tangent',
  },
  { decision: 'reopen', label: 'Reopen', target: 'open', className: 'decide-reopen' },
];

const STRUCTURAL: readonly ItemStatus[] = ['split', 'merged', 'superseded'];

export function DecideSection({ item }: { item: ItemDto }) {
  const [rationale, setRationale] = useState('');
  const [qualification, setQualification] = useState('');
  const [qualifying, setQualifying] = useState(false);
  const decide = useAction(
    (body: DecisionInput) => api.decide(item.id, body),
    () => {
      setRationale('');
      setQualification('');
      setQualifying(false);
    },
  );

  if (item.kind === 'original_idea' || item.kind === 'synthesis') {
    return (
      <PanelSection title="Decide">
        <p className="muted">
          {item.kind === 'original_idea'
            ? 'Your original idea is permanent provenance. It is never accepted or rejected; decide on the claims extracted from it instead.'
            : 'A synthesis is a record of the process. To change it, change your review decisions and re-run the synthesis.'}
        </p>
      </PanelSection>
    );
  }
  if (STRUCTURAL.includes(item.status)) {
    return (
      <PanelSection title="Decide">
        <p className="muted">
          This item is already {item.status}; continue with the items it produced (see “Led to”
          under Provenance).
        </p>
      </PanelSection>
    );
  }

  const send = (decision: DecisionType) =>
    decide.mutate({
      decision,
      rationale: rationale.trim() || undefined,
      qualification: decision === 'qualify' ? qualification.trim() : undefined,
    });

  return (
    <PanelSection title="Decide">
      <p className="hint">{ACCEPTED_HINT} Every decision is recorded and can be reopened.</p>
      <label>
        Rationale (optional)
        <textarea
          rows={2}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why? Your future self will thank you."
        />
      </label>
      <div className="decide-buttons">
        <DecideButton choice={ACCEPT} item={item} busy={decide.isPending} onChoose={send} />
        <button
          type="button"
          className="decide-qualify"
          title={ACCEPTED_HINT}
          aria-expanded={qualifying}
          disabled={decide.isPending}
          onClick={() => setQualifying((open) => !open)}
        >
          Accept with qualification…
        </button>
        {OTHER_CHOICES.map((choice) => (
          <DecideButton
            key={choice.decision}
            choice={choice}
            item={item}
            busy={decide.isPending}
            onChoose={send}
          />
        ))}
      </div>
      {qualifying && (
        <div className="inline-form">
          <label>
            Qualification (required) — under what condition or with what caveat do you accept this?
            <textarea
              rows={2}
              value={qualification}
              onChange={(e) => setQualification(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="primary"
              disabled={decide.isPending || !qualification.trim()}
              onClick={() => send('qualify')}
            >
              Accept with this qualification
            </button>
          </div>
        </div>
      )}
      <ErrorNote error={decide.error} />
    </PanelSection>
  );
}

interface DecideButtonProps {
  choice: Choice;
  item: ItemDto;
  busy: boolean;
  onChoose: (decision: DecisionType) => void;
}

function DecideButton({ choice, item, busy, onChoose }: DecideButtonProps) {
  return (
    <button
      type="button"
      className={choice.className}
      title={choice.title}
      disabled={busy || item.status === choice.target}
      onClick={() => onChoose(choice.decision)}
    >
      {choice.label}
    </button>
  );
}
