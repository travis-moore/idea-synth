import { useState } from 'react';
import type { FormEvent } from 'react';
import type { EvidenceDto, ItemDetailDto } from '../../../src/api-types';
import { api } from '../api';
import type { EvidenceInput } from '../api';
import { ActorBadge, VerdictChip } from '../components/Badges';
import { ErrorNote } from '../components/Feedback';
import { ItemChip } from '../components/ItemChip';
import { useAction } from '../queries';
import { PanelSection } from './PanelParts';

function EvidenceRow({ evidence }: { evidence: EvidenceDto }) {
  return (
    <li className={`evidence-row stance-${evidence.stance}`}>
      <div className="record-head">
        <span className={`chip tone-${evidence.stance === 'for' ? 'good' : 'bad'}`}>
          {evidence.stance === 'for' ? 'Evidence for' : 'Evidence against'}
        </span>
        <span className="evidence-source">
          {evidence.url ? (
            <a href={evidence.url} target="_blank" rel="noreferrer noopener">
              {evidence.sourceTitle}
            </a>
          ) : (
            evidence.sourceTitle
          )}
        </span>
      </div>
      <ItemChip item={evidence.item} length={90} />
      {evidence.excerpt && <blockquote className="source-quote">{evidence.excerpt}</blockquote>}
    </li>
  );
}

const EMPTY_EVIDENCE: EvidenceInput = {
  text: '',
  stance: 'for',
  sourceTitle: '',
  url: '',
  excerpt: '',
};

function AttachEvidenceForm({ itemId }: { itemId: string }) {
  const [form, setForm] = useState<EvidenceInput>(EMPTY_EVIDENCE);
  const attach = useAction(
    (body: EvidenceInput) => api.attachEvidence(itemId, body),
    () => setForm(EMPTY_EVIDENCE),
  );
  const set = <K extends keyof EvidenceInput>(key: K, value: EvidenceInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    attach.mutate({
      text: form.text,
      stance: form.stance,
      sourceTitle: form.sourceTitle,
      url: form.url?.trim() || undefined,
      excerpt: form.excerpt?.trim() || undefined,
    });
  };

  return (
    <details className="sub-form">
      <summary>Attach evidence</summary>
      <form className="inline-form" onSubmit={submit}>
        <label>
          What the evidence shows
          <textarea
            rows={2}
            value={form.text}
            onChange={(e) => set('text', e.target.value)}
            required
          />
        </label>
        <div className="form-row">
          <label>
            Stance
            <select
              value={form.stance}
              onChange={(e) => set('stance', e.target.value === 'against' ? 'against' : 'for')}
            >
              <option value="for">For this item</option>
              <option value="against">Against this item</option>
            </select>
          </label>
          <label className="grow">
            Source title
            <input
              type="text"
              value={form.sourceTitle}
              onChange={(e) => set('sourceTitle', e.target.value)}
              required
            />
          </label>
        </div>
        <label>
          URL (optional)
          <input
            type="url"
            value={form.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://…"
          />
        </label>
        <label>
          Excerpt (optional)
          <textarea
            rows={2}
            value={form.excerpt}
            onChange={(e) => set('excerpt', e.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            type="submit"
            disabled={attach.isPending || !form.text.trim() || !form.sourceTitle.trim()}
          >
            {attach.isPending ? 'Attaching…' : 'Attach evidence'}
          </button>
        </div>
        <ErrorNote error={attach.error} />
      </form>
    </details>
  );
}

export function EpistemicSection({ detail }: { detail: ItemDetailDto }) {
  const { item, assessments, evidence } = detail;
  const canAttach = item.kind !== 'original_idea' && item.kind !== 'synthesis';
  return (
    <PanelSection title="Epistemic review">
      {assessments.length === 0 ? (
        <p className="muted">This item has not been fact-checked.</p>
      ) : (
        <ul className="record-list">
          {assessments.map((assessment) => (
            <li key={assessment.id}>
              <div className="record-head">
                <VerdictChip verdict={assessment.verdict} />
                <ActorBadge actor={assessment.author} />
              </div>
              <p className="record-text">{assessment.rationale}</p>
            </li>
          ))}
        </ul>
      )}
      <h4>Evidence</h4>
      {evidence.length === 0 ? (
        <p className="muted">No evidence attached.</p>
      ) : (
        <ul className="record-list">
          {evidence.map((entry) => (
            <EvidenceRow key={entry.item.id} evidence={entry} />
          ))}
        </ul>
      )}
      {canAttach && <AttachEvidenceForm itemId={item.id} />}
    </PanelSection>
  );
}
