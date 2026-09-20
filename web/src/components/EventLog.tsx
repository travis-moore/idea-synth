import type { EventDto } from '../../../src/api-types';
import { useOpenItem } from '../itemNavigation';
import { formatTime } from '../labels';
import { ActorBadge } from './Badges';

function compactPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
}

/** The audit log. Shared by the History tab and the item panel's "Full history". */
export function EventLog({ events }: { events: EventDto[] }) {
  const openItem = useOpenItem();
  if (events.length === 0) return <p className="muted">No events recorded.</p>;
  return (
    <ol className="event-log">
      {events.map((event) => {
        const { itemId } = event;
        const content = (
          <>
            <span className="event-seq">#{event.seq}</span>
            <ActorBadge actor={event.actor} />
            <span className="event-type">{event.type}</span>
            <span className="event-payload">{compactPayload(event.payload)}</span>
            <time className="muted">{formatTime(event.createdAt)}</time>
          </>
        );
        return (
          <li key={event.seq}>
            {itemId ? (
              <button
                type="button"
                className="event-row clickable"
                onClick={() => openItem(itemId)}
              >
                {content}
              </button>
            ) : (
              <div className="event-row">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
