import type { ReactNode } from 'react';
import type { ItemDto } from '../../../src/api-types';
import type {
  Actor,
  EpistemicVerdict,
  ItemKind,
  ItemStatus,
  Origin,
} from '../../../src/domain/vocabulary';
import {
  ACTOR_LABELS,
  KIND_LABELS,
  ORIGIN_CAPTIONS,
  ORIGIN_LABELS,
  STATUS_HINTS,
  STATUS_LABELS,
  VERDICT_LABELS,
  VERDICT_TONES,
} from '../labels';
import type { Tone } from '../labels';

export function OriginBadge({ origin }: { origin: Origin }) {
  return (
    <span className={`badge origin-${origin}`} title={ORIGIN_CAPTIONS[origin] ?? 'Your own words'}>
      {ORIGIN_LABELS[origin]}
    </span>
  );
}

export function KindBadge({ kind }: { kind: ItemKind }) {
  return <span className={`badge kind kind-${kind}`}>{KIND_LABELS[kind]}</span>;
}

export function StatusBadge({ status }: { status: ItemStatus }) {
  return (
    <span className={`badge status-${status}`} title={STATUS_HINTS[status]}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function VerdictChip({ verdict }: { verdict: EpistemicVerdict }) {
  return (
    <span className={`chip tone-${VERDICT_TONES[verdict]}`} title="Epistemic review verdict">
      {VERDICT_LABELS[verdict]}
    </span>
  );
}

export function ToneChip({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip tone-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Who wrote something: the user, the AI, or the application itself. */
export function ActorBadge({ actor }: { actor: Actor }) {
  return <span className={`badge actor-${actor}`}>{ACTOR_LABELS[actor]}</span>;
}

export function ProductiveBadge() {
  return (
    <span
      className="badge productive"
      title="This premise did not survive, but ideas that arose from it are still alive."
    >
      False premise · Productive idea
    </span>
  );
}

/** The standard badge row for an item, used by cards, the panel header and graph tooltips. */
export function ItemBadges({ item }: { item: ItemDto }) {
  return (
    <span className="badge-row">
      <OriginBadge origin={item.origin} />
      <KindBadge kind={item.kind} />
      <StatusBadge status={item.status} />
      {item.epistemicVerdict && <VerdictChip verdict={item.epistemicVerdict} />}
      {item.productiveDescendantIds.length > 0 && <ProductiveBadge />}
    </span>
  );
}
