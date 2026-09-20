import { useState } from 'react';
import type { ItemDetailDto } from '../../../src/api-types';
import { api } from '../api';
import { ErrorNote } from '../components/Feedback';
import { JobStrip } from '../components/JobStrip';
import { AUTHOR_LABELS, VIEWER_MODE_HINT, formatTime } from '../labels';
import { isActiveJob, useAction, useCanReason, useJobs, useViewerMode } from '../queries';
import { PanelSection } from './PanelParts';

/** The discussion attached to this one item. Deliberately small: the item is the subject, not the chat. */
export function DiscussionSection({ detail }: { detail: ItemDetailDto }) {
  const [draft, setDraft] = useState('');
  const post = useAction(
    (askAgent: boolean) => api.postMessage(detail.item.id, { body: draft, askAgent }),
    () => setDraft(''),
  );
  const canReason = useCanReason();
  const viewer = useViewerMode();
  const jobs = useJobs(detail.idea.id);
  // Your message is stored at once; the AI's reply is a background job and arrives live.
  const replyJob = jobs.data?.find(
    (job) => job.kind === 'discuss_reply' && job.itemId === detail.item.id && isActiveJob(job),
  );
  const canPost = draft.trim().length > 0 && !post.isPending;

  return (
    <PanelSection title={`Discussion (${detail.messages.length})`}>
      {detail.messages.length === 0 ? (
        <p className="muted">
          No discussion yet. Add a note for yourself
          {viewer ? '; your VS Code agent can read it.' : ', or ask the AI about this item.'}
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
      <JobStrip ideaId={detail.idea.id} itemId={detail.item.id} />
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
          {canReason && (
            <button
              type="button"
              className="ask-ai"
              disabled={!canPost || replyJob !== undefined}
              title="Saves your message, then queues an AI reply"
              onClick={() => post.mutate(true)}
            >
              {replyJob ? 'AI reply queued…' : 'Ask the AI'}
            </button>
          )}
        </div>
        {viewer && <p className="viewer-note">{VIEWER_MODE_HINT}</p>}
        <ErrorNote error={post.error} />
      </div>
    </PanelSection>
  );
}
