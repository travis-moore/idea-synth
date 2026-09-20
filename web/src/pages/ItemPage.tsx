import { Link, useParams } from 'react-router-dom';
import { ItemPanel } from '../item/ItemPanel';
import { itemInIdeaPath } from '../itemNavigation';
import { useItem } from '../queries';

/** The item panel as a full page, for deep links and long discussions. */
export function ItemPage() {
  const { itemId = '' } = useParams();
  const detail = useItem(itemId);
  return (
    <div className="item-page">
      {detail.data && (
        <p className="breadcrumbs">
          <Link to={`/ideas/${detail.data.idea.id}`}>{detail.data.idea.title}</Link>
          {' · '}
          <Link to={itemInIdeaPath(detail.data.idea.id, itemId, 'map')}>Show on map</Link>
        </p>
      )}
      <ItemPanel key={itemId} itemId={itemId} />
    </div>
  );
}
