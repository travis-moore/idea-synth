import type { ItemDto } from '../../../src/api-types';
import { KIND_LABELS, ORIGIN_LABELS, STATUS_LABELS, truncate } from '../labels';
import { useOpenItem } from '../itemNavigation';

/** A small origin-coloured provenance chip: kind + the start of the text. Opens the item panel. */
export function ItemChip({ item, length = 40 }: { item: ItemDto; length?: number }) {
  const openItem = useOpenItem();
  return (
    <button
      type="button"
      className={`item-chip origin-${item.origin} status-${item.status}`}
      title={`${ORIGIN_LABELS[item.origin]} · ${STATUS_LABELS[item.status]} — ${item.text}`}
      onClick={() => openItem(item.id)}
    >
      <span className="item-chip-kind">{KIND_LABELS[item.kind]}</span>
      <span className="item-chip-text">{truncate(item.text, length)}</span>
    </button>
  );
}

/** A reference to an item we have no details for (it should not happen, but never hide a ref). */
export function UnknownItemChip({ itemId }: { itemId: string }) {
  const openItem = useOpenItem();
  return (
    <button type="button" className="item-chip" onClick={() => openItem(itemId)}>
      <span className="item-chip-kind">Item</span>
      <span className="item-chip-text">{itemId}</span>
    </button>
  );
}
