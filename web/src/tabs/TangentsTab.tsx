import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { IdeaDto, ItemDto } from '../../../src/api-types';
import { api } from '../api';
import { EmptyState, ErrorNote, Loading } from '../components/Feedback';
import { ItemCard } from '../components/ItemCard';
import { useOpenItem } from '../itemNavigation';
import { useAction, useTangents } from '../queries';

function PromoteForm({ item, onCancel }: { item: ItemDto; onCancel: () => void }) {
  const navigate = useNavigate();
  const [framing, setFraming] = useState('');
  const promote = useAction(
    (body: { framing?: string }) => api.promoteTangent(item.id, body),
    (idea) => void navigate(`/ideas/${idea.id}`),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    promote.mutate({ framing: framing.trim() || undefined });
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      <label>
        Reframe in your own words (optional)
        <textarea
          rows={3}
          value={framing}
          onChange={(e) => setFraming(e.target.value)}
          placeholder="Leave empty to start from the tangent exactly as it is."
        />
      </label>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={promote.isPending}>
          {promote.isPending ? 'Creating…' : 'Create new idea'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ErrorNote error={promote.error} />
    </form>
  );
}

function TangentRow({ item }: { item: ItemDto }) {
  const openItem = useOpenItem();
  const [promoting, setPromoting] = useState(false);
  return (
    <div className="tangent-row">
      <ItemCard item={item} onOpen={() => openItem(item.id)} />
      <div className="tangent-actions">
        {item.promotedIdeaId ? (
          <Link to={`/ideas/${item.promotedIdeaId}`}>Promoted → open idea</Link>
        ) : promoting ? (
          <PromoteForm item={item} onCancel={() => setPromoting(false)} />
        ) : (
          <button type="button" onClick={() => setPromoting(true)}>
            Explore as a new idea
          </button>
        )}
      </div>
    </div>
  );
}

export function TangentsTab({ idea }: { idea: IdeaDto }) {
  const tangents = useTangents(idea.id);
  if (tangents.isPending) return <Loading />;
  if (tangents.error) return <ErrorNote error={tangents.error} />;
  if (tangents.data.length === 0) {
    return (
      <EmptyState title="No tangents in this idea">
        When a thought is interesting but off the main line, set it aside as a tangent from its item
        panel. It is kept here and can grow into its own idea later.
      </EmptyState>
    );
  }
  return (
    <div className="card-list">
      {tangents.data.map((item) => (
        <TangentRow key={item.id} item={item} />
      ))}
    </div>
  );
}
