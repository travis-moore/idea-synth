import type { ReactNode } from 'react';
import type { ItemDetailDto, LinkedItemDto, SourceSpanDto } from '../../../src/api-types';
import { RELATION_TYPES } from '../../../src/domain/vocabulary';
import { ItemChip } from '../components/ItemChip';
import { PASS_LABELS } from '../labels';
import { PanelSection } from './PanelParts';

interface Range {
  start: number;
  end: number;
}

/** Valid, sorted, non-overlapping highlight ranges within a text of the given length. */
function mergeRanges(sources: SourceSpanDto[], length: number): Range[] {
  const ranges = sources
    .flatMap((s): Range[] =>
      s.startOffset !== null && s.endOffset !== null
        ? [{ start: s.startOffset, end: s.endOffset }]
        : [],
    )
    .filter((r) => r.start >= 0 && r.end <= length && r.start < r.end)
    .sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function HighlightedOriginal({ text, sources }: { text: string; sources: SourceSpanDto[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of mergeRanges(sources, text.length)) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(<mark key={range.start}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <p className="original-text compact">{parts}</p>;
}

type Side = 'parent' | 'child' | 'other';

/**
 * Genealogical links say where an item came from. `flow` says which end arose first, and
 * `direction` says which end this item is: together they give parent vs child.
 */
function sideOf(link: LinkedItemDto): Side {
  const meta = RELATION_TYPES[link.relation.type];
  if (!meta.genealogical) return 'other';
  const otherIsLaterEnd = (meta.flow === 'forward') === (link.direction === 'out');
  return otherIsLaterEnd ? 'child' : 'parent';
}

function LinkRow({ link }: { link: LinkedItemDto }) {
  const label = RELATION_TYPES[link.relation.type].label;
  return (
    <li className="link-row">
      {link.direction === 'out' ? (
        <>
          <span className="relation-label">this item — {label} →</span>
          <ItemChip item={link.item} length={60} />
        </>
      ) : (
        <>
          <ItemChip item={link.item} length={60} />
          <span className="relation-label">— {label} → this item</span>
        </>
      )}
      {link.relation.note && <span className="hint">(note: {link.relation.note})</span>}
    </li>
  );
}

function LinkGroup({ title, links }: { title: string; links: LinkedItemDto[] }) {
  if (links.length === 0) return null;
  return (
    <div className="link-group">
      <h4>{title}</h4>
      <ul>
        {links.map((link) => (
          <LinkRow key={link.relation.id} link={link} />
        ))}
      </ul>
    </div>
  );
}

export function ProvenanceSection({ detail }: { detail: ItemDetailDto }) {
  const { item, idea, sources, links } = detail;
  const located = sources.filter((s) => s.startOffset !== null && s.endOffset !== null);
  const unlocated = sources.filter((s) => s.startOffset === null || s.endOffset === null);
  const bySide = (side: Side) => links.filter((link) => sideOf(link) === side);

  return (
    <PanelSection title="Provenance">
      <p className="hint">
        {item.createdByPass
          ? `Created by the AI in: ${PASS_LABELS[item.createdByPass]}`
          : 'Written by you, not by an AI pass.'}
      </p>

      {located.length > 0 && (
        <div className="source-block origin-user">
          <h4>Where this is in your original words</h4>
          <HighlightedOriginal text={idea.originalText} sources={located} />
        </div>
      )}
      {unlocated.map((source) => (
        <blockquote key={source.id} className="source-quote">
          “{source.quote}” <span className="hint">— could not be located in the original</span>
        </blockquote>
      ))}

      <LinkGroup title="Arose from" links={bySide('parent')} />
      <LinkGroup title="Led to" links={bySide('child')} />
      <LinkGroup title="Other links" links={bySide('other')} />
      {links.length === 0 && <p className="muted">No relationships to other items.</p>}
    </PanelSection>
  );
}
