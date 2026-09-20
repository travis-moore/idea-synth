import type { ItemDetailDto, ItemDto } from '../../../src/api-types';
import { ItemBadges } from '../components/Badges';
import { EventLog } from '../components/EventLog';
import { ErrorNote, Loading } from '../components/Feedback';
import { ATTENTION_LABELS, ORIGIN_CAPTIONS } from '../labels';
import { useItem } from '../queries';
import { DecideSection } from './DecideSection';
import { DiscussionSection } from './DiscussionSection';
import { EpistemicSection } from './EpistemicSection';
import { Collapsible, PanelSection } from './PanelParts';
import type { ItemLookup } from './PanelParts';
import { ProvenanceSection } from './ProvenanceSection';
import { DecisionHistory, RevisionList } from './RecordSections';
import { RestructureSection } from './RestructureSection';

/** Every item the detail payload already carries, so ids elsewhere in it can be shown as chips. */
function knownItems(detail: ItemDetailDto): ItemLookup {
  const items = new Map<string, ItemDto>([[detail.item.id, detail.item]]);
  for (const link of detail.links) items.set(link.item.id, link.item);
  for (const evidence of detail.evidence) items.set(evidence.item.id, evidence.item);
  return items;
}

/** The "Idea Detail / Discussion" view. Used inside the drawer and as a full page. */
export function ItemPanel({ itemId }: { itemId: string }) {
  const detail = useItem(itemId);
  // Live refreshes happen while the user may be typing in this panel: a failed background
  // refetch must never replace the forms, so an error only shows when there is no data.
  const data = detail.data;
  if (!data) return detail.error ? <ErrorNote error={detail.error} /> : <Loading />;
  const { item } = data;
  const items = knownItems(data);
  const caption = ORIGIN_CAPTIONS[item.origin];

  return (
    <article className={`item-panel origin-${item.origin}`}>
      <div className="item-panel-badges">
        <ItemBadges item={item} />
      </div>
      <header className="item-panel-header">
        <p className={`item-panel-text status-${item.status}`}>{item.text}</p>
        {caption && <p className="origin-caption">{caption}</p>}
        {item.status === 'needs_user' && item.attentionReason && (
          <p className="attention-note">{ATTENTION_LABELS[item.attentionReason]}</p>
        )}
      </header>

      <ProvenanceSection detail={data} />
      <EpistemicSection detail={data} />
      <DecideSection item={item} />
      <RestructureSection item={item} />
      <DiscussionSection detail={data} />
      {data.revisions.length > 1 && (
        <PanelSection title="Revisions">
          <RevisionList revisions={data.revisions} items={items} />
        </PanelSection>
      )}
      <Collapsible title={`Decision history (${data.decisions.length})`}>
        <DecisionHistory decisions={data.decisions} items={items} />
      </Collapsible>
      <Collapsible title={`Full history (${data.events.length})`}>
        <EventLog events={data.events} />
      </Collapsible>
    </article>
  );
}
