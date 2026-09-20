/**
 * The item panel is addressed by URL so it is linkable: `?item=<id>` opens the drawer over
 * any page, and `/items/<id>` is the same panel as a full page.
 */
import { useCallback } from 'react';
import { useMatch, useNavigate, useSearchParams } from 'react-router-dom';

const ITEM_PARAM = 'item';

export function useSelectedItemId(): string | null {
  const [params] = useSearchParams();
  return params.get(ITEM_PARAM);
}

/** Open an item in whichever panel is current: the full page if we are on it, else the drawer. */
export function useOpenItem(): (itemId: string) => void {
  const onItemPage = useMatch('/items/:itemId') !== null;
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  return useCallback(
    (itemId: string) => {
      if (onItemPage) {
        void navigate(`/items/${encodeURIComponent(itemId)}`);
        return;
      }
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.set(ITEM_PARAM, itemId);
        return next;
      });
    },
    [onItemPage, navigate, setParams],
  );
}

export function useCloseItem(): () => void {
  const [, setParams] = useSearchParams();
  return useCallback(() => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete(ITEM_PARAM);
      return next;
    });
  }, [setParams]);
}

/** Link to an item inside its idea workspace, with the drawer open. */
export function itemInIdeaPath(ideaId: string, itemId: string, tab = 'review'): string {
  return `/ideas/${encodeURIComponent(ideaId)}?tab=${tab}&${ITEM_PARAM}=${encodeURIComponent(itemId)}`;
}
