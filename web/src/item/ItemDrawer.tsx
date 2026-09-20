import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useCloseItem, useSelectedItemId } from '../itemNavigation';
import { ItemPanel } from './ItemPanel';

/** Right-hand slide-over showing the item named by `?item=`. Rendered once, at the app root. */
export function ItemDrawer() {
  const itemId = useSelectedItemId();
  const close = useCloseItem();

  useEffect(() => {
    if (!itemId) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [itemId, close]);

  if (!itemId) return null;
  return (
    <aside className="drawer" aria-label="Item detail and discussion">
      <div className="drawer-bar">
        <Link to={`/items/${encodeURIComponent(itemId)}`} className="small-link">
          Open as full page
        </Link>
        <button type="button" className="ghost" onClick={close} aria-label="Close item panel">
          ✕ Close
        </button>
      </div>
      <div className="drawer-body">
        <ItemPanel key={itemId} itemId={itemId} />
      </div>
    </aside>
  );
}
