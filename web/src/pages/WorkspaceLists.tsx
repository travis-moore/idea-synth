import type { UseQueryResult } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { ItemWithIdeaDto } from '../../../src/api-types';
import { EmptyState, ErrorNote, Loading } from '../components/Feedback';
import { ItemCard } from '../components/ItemCard';
import { itemInIdeaPath } from '../itemNavigation';
import { useInbox, useOpenQuestions, useTangents } from '../queries';

interface IdeaGroup {
  ideaId: string;
  ideaTitle: string;
  items: ItemWithIdeaDto[];
}

function groupByIdea(items: ItemWithIdeaDto[]): IdeaGroup[] {
  const groups = new Map<string, IdeaGroup>();
  for (const item of items) {
    const group = groups.get(item.ideaId) ?? {
      ideaId: item.ideaId,
      ideaTitle: item.ideaTitle,
      items: [],
    };
    group.items.push(item);
    groups.set(item.ideaId, group);
  }
  return [...groups.values()];
}

interface WorkspaceListProps {
  title: string;
  intro: string;
  emptyTitle: string;
  emptyText: string;
  tab: string;
  query: UseQueryResult<ItemWithIdeaDto[]>;
}

function WorkspaceList({ title, intro, emptyTitle, emptyText, tab, query }: WorkspaceListProps) {
  const navigate = useNavigate();
  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">{intro}</p>
      {query.isPending && <Loading />}
      <ErrorNote error={query.error} />
      {query.data?.length === 0 && <EmptyState title={emptyTitle}>{emptyText}</EmptyState>}
      {groupByIdea(query.data ?? []).map((group) => (
        <div key={group.ideaId} className="list-group">
          <h2>
            <Link to={`/ideas/${group.ideaId}`}>{group.ideaTitle}</Link>
            <span className="muted"> · {group.items.length}</span>
          </h2>
          <div className="card-list">
            {group.items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                onOpen={() => void navigate(itemInIdeaPath(item.ideaId, item.id, tab))}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function InboxPage() {
  return (
    <WorkspaceList
      title="Inbox"
      intro="Items across all your ideas where the AI is waiting for your judgement."
      emptyTitle="Nothing needs you right now"
      emptyText="When an analysis raises something only you can decide, it will appear here."
      tab="review"
      query={useInbox()}
    />
  );
}

export function OpenQuestionsPage() {
  return (
    <WorkspaceList
      title="Open Questions"
      intro="Questions that are still unresolved, across all your ideas."
      emptyTitle="No open questions"
      emptyText="Questions raised during analysis or review collect here until you resolve them."
      tab="review"
      query={useOpenQuestions()}
    />
  );
}

export function TangentLibraryPage() {
  return (
    <WorkspaceList
      title="Tangent Library"
      intro="Thoughts set aside from their original line of reasoning. Any of them can grow into its own idea."
      emptyTitle="No tangents yet"
      emptyText="Set an item aside as a tangent during review and it will be kept here for later."
      tab="tangents"
      query={useTangents()}
    />
  );
}
