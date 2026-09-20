import type { ItemDto } from '../../../src/api-types';
import { ATTENTION_LABELS } from '../labels';
import { ItemBadges } from './Badges';

interface ItemCardProps {
  item: ItemDto;
  onOpen: (item: ItemDto) => void;
  selected?: boolean;
}

/** One reasoning item in a list. The whole card is the button that opens the item panel. */
export function ItemCard({ item, onOpen, selected = false }: ItemCardProps) {
  const classes = ['item-card', `origin-${item.origin}`, `status-${item.status}`];
  if (selected) classes.push('selected');
  return (
    <button type="button" className={classes.join(' ')} onClick={() => onOpen(item)}>
      <ItemBadges item={item} />
      <span className="item-card-text">{item.text}</span>
      {item.status === 'needs_user' && item.attentionReason && (
        <span className="item-card-attention">{ATTENTION_LABELS[item.attentionReason]}</span>
      )}
      <span className="item-card-meta">
        <span title="Messages in this item's discussion">💬 {item.messageCount}</span>
        {item.revisionCount > 1 && (
          <span title="Times this item was reworded">✎ {item.revisionCount} revisions</span>
        )}
        {item.promotedIdeaId && <span>↗ promoted to its own idea</span>}
      </span>
    </button>
  );
}
