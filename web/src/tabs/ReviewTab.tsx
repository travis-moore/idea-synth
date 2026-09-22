import type { IdeaDto, ItemDto } from '../../../src/api-types';
import type { ItemStatus } from '../../../src/domain/vocabulary';
import { EmptyState, ErrorNote, Loading } from '../components/Feedback';
import { ItemCard } from '../components/ItemCard';
import { useOpenItem, useSelectedItemId } from '../itemNavigation';
import { useGraph } from '../queries';

interface Section {
  title: string;
  hint: string;
  statuses: readonly ItemStatus[];
}

// Tangents are reviewed in their own tab.
const SECTIONS: readonly Section[] = [
  {
    title: 'Needs you',
    hint: 'The AI is waiting for your judgement. These block the synthesis.',
    statuses: ['needs_user'],
  },
  {
    title: 'Open',
    hint: 'Not yet decided. They do not block; they become open questions.',
    statuses: ['open'],
  },
  {
    title: 'Resolved',
    hint: 'Decided into — or out of — your current reasoning. Not a claim about truth.',
    statuses: ['accepted', 'qualified', 'responded', 'rejected'],
  },
  {
    title: 'Structural',
    hint: 'Split, merged or replaced. Continue with the items they produced.',
    statuses: ['split', 'merged', 'superseded'],
  },
];

function isReviewable(item: ItemDto): boolean {
  return item.kind !== 'original_idea' && item.kind !== 'synthesis';
}

export function ReviewTab({ idea }: { idea: IdeaDto }) {
  const graph = useGraph(idea.id);
  const openItem = useOpenItem();
  const selectedId = useSelectedItemId();

  if (graph.isPending) return <Loading />;
  if (graph.error) return <ErrorNote error={graph.error} />;

  const items = graph.data.nodes.filter(isReviewable);
  if (items.length === 0) {
    return (
      <EmptyState title="Nothing to review yet">
        Run the analysis from the Overview tab and the extracted claims, branches, corrections and
        objections will appear here.
      </EmptyState>
    );
  }

  return (
    <div className="review">
      {SECTIONS.map((section) => {
        const sectionItems = items.filter((item) => section.statuses.includes(item.status));
        if (sectionItems.length === 0) return null;
        return (
          <section key={section.title} className="review-section">
            <h2>
              {section.title} <span className="muted">· {sectionItems.length}</span>
            </h2>
            <p className="hint">{section.hint}</p>
            <div className="card-list">
              {sectionItems.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onOpen={() => openItem(item.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
