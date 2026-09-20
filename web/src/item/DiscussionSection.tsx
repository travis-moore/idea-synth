import { useState } from 'react';
import type { ItemDetailDto } from '../../../src/api-types';
import { api } from '../api';
import { ErrorNote } from '../components/Feedback';
import { AUTHOR_LABELS, formatTime } from '../labels';
import { useAction } from '../queries';
import { PanelSection } from './PanelParts';

/** The discussion attached to this one item. Deliberately small: the item is the subject, not the chat. */
export function DiscussionSection({ detail }: { detail: ItemDetailDto }) {
  const [draft, setDraft] = useState('');
  const post = useAction(
    (askAgent: boolean) => api.postMessage(detail.item.id, { body: draft, askAgent }),
    () => setDraft(''),
  );
  const canPost = draft.trim().length > 0 && !post.isPending;

  return (
    <PanelSection title={`Discussion (${detail.messages.length})`}>
      {detail.messages.length === 0 ? (
        <p className="muted">
          No discussion yet. Add a note for yourself, or ask the AI about this item.
        </p>
      ) : (
        <ol className="thread">
          {detail.messages.map((message) => (
            <li key={message.id} className={`message author-${message.author}`}>
              <div className="message-head">
                <span className={`badge actor-${message.author}`}>
                  {AUTHOR_LABELS[message.author]}
                </span>
                <time className="muted">{formatTime(message.createdAt)}</time>
              </div>
              <p className="message-body">{message.body}</p>
            </li>
          ))}
        </ol>
      )}
      <div className="composer">
        <textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Your thoughts on this item…"
          aria-label="Message"
        />
        <div className="form-actions">
          <button type="button" disabled={!canPost} onClick={() => post.mutate(false)}>
            Add note
          </button>
          <button
            type="button"
            className="ask-ai"
            disabled={!canPost}
            onClick={() => post.mutate(true)}
          >
            {post.isPending ? 'Waiting…' : 'Ask the AI'}
          </button>
        </div>
        <ErrorNote error={post.error} />
      </div>
    </PanelSection>
  );
}
