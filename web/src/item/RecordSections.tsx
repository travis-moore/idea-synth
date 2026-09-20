import type { DecisionDto, RevisionDto } from '../../../src/api-types';
import { ActorBadge } from '../components/Badges';
import { ItemChip, UnknownItemChip } from '../components/ItemChip';
import { DECISION_LABELS, STATUS_LABELS, formatTime } from '../labels';
import type { ItemLookup } from './PanelParts';

function ChipFor({ itemId, items }: { itemId: string; items: ItemLookup }) {
  const item = items.get(itemId);
  return item ? <ItemChip item={item} /> : <UnknownItemChip itemId={itemId} />;
}

export function RevisionList({
  revisions,
  items,
}: {
  revisions: RevisionDto[];
  items: ItemLookup;
}) {
  return (
    <ol className="record-list">
      {revisions.map((revision) => (
        <li key={revision.id}>
          <div className="record-head">
            <span className="record-seq">r{revision.seq}</span>
            <ActorBadge actor={revision.author} />
            <time className="muted">{formatTime(revision.createdAt)}</time>
          </div>
          <p className="record-text">{revision.text}</p>
          {revision.reason && <p className="hint">Reason: {revision.reason}</p>}
          {revision.causedByItemId && (
            <p className="hint">
              Prompted by <ChipFor itemId={revision.causedByItemId} items={items} />
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function DecisionHistory({
  decisions,
  items,
}: {
  decisions: DecisionDto[];
  items: ItemLookup;
}) {
  if (decisions.length === 0) return <p className="muted">No decisions recorded yet.</p>;
  return (
    <ol className="record-list">
      {decisions.map((decision) => (
        <li key={decision.id}>
          <div className="record-head">
            <span className="record-seq">#{decision.seq}</span>
            <ActorBadge actor={decision.author} />
            <strong>{DECISION_LABELS[decision.type]}</strong>
            <span className="muted">
              {STATUS_LABELS[decision.fromStatus]} → {STATUS_LABELS[decision.toStatus]}
            </span>
            <time className="muted">{formatTime(decision.createdAt)}</time>
          </div>
          {decision.relayedBy && (
            <p className="relayed-note">
              Relayed by {decision.relayedBy}
              {decision.userInstruction ? <> — you said: “{decision.userInstruction}”</> : null}
            </p>
          )}
          {decision.qualification && (
            <p className="record-text">Qualification: {decision.qualification}</p>
          )}
          {decision.rationale && <p className="hint">Rationale: {decision.rationale}</p>}
          {decision.relatedItemIds.length > 0 && (
            <p className="refs">
              {decision.relatedItemIds.map((id) => (
                <ChipFor key={id} itemId={id} items={items} />
              ))}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
