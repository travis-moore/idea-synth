import { useSearchParams } from 'react-router-dom';
import type { IdeaDto, ItemDto, SynthesisDto, TracedLineDto } from '../../../src/api-types';
import { ToneChip } from '../components/Badges';
import { EmptyState, ErrorNote, Loading } from '../components/Feedback';
import { ItemChip, UnknownItemChip } from '../components/ItemChip';
import { CONFIDENCE_TONES, formatTime } from '../labels';
import { useSynthesis } from '../queries';

type ItemLookup = ReadonlyMap<string, ItemDto>;

function Refs({ refs, items }: { refs: string[]; items: ItemLookup }) {
  if (refs.length === 0) return null;
  return (
    <span className="refs" aria-label="Rests on">
      {[...new Set(refs)].map((ref) => {
        const item = items.get(ref);
        return item ? (
          <ItemChip key={ref} item={item} />
        ) : (
          <UnknownItemChip key={ref} itemId={ref} />
        );
      })}
    </span>
  );
}

function TracedLine({ line, items }: { line: TracedLineDto; items: ItemLookup }) {
  return (
    <>
      <span className="traced-text">{line.text}</span>
      <Refs refs={line.refs} items={items} />
    </>
  );
}

function LineSection({
  title,
  lines,
  items,
}: {
  title: string;
  lines: TracedLineDto[];
  items: ItemLookup;
}) {
  return (
    <section className="synthesis-section">
      <h3>{title}</h3>
      {lines.length === 0 ? (
        <p className="muted">Nothing recorded.</p>
      ) : (
        <ul className="traced-list">
          {lines.map((line, index) => (
            <li key={index}>
              <TracedLine line={line} items={items} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SynthesisBody({ synthesis }: { synthesis: SynthesisDto }) {
  const { body } = synthesis;
  const items: ItemLookup = new Map(synthesis.referencedItems.map((item) => [item.id, item]));
  return (
    <>
      <blockquote className="synthesis-statement">{body.statement}</blockquote>
      <p className="hint">
        Conclusions are the current state of your reasoning, not established facts.
      </p>

      <section className="synthesis-section">
        <h3>What you initially thought</h3>
        <p>
          <TracedLine line={body.initialThought} items={items} />
        </p>
      </section>
      <LineSection title="What changed" lines={body.whatChanged} items={items} />
      <LineSection title="What was rejected" lines={body.rejected} items={items} />
      <LineSection title="What remains uncertain" lines={body.uncertain} items={items} />

      <section className="synthesis-section conclusions">
        <h3>Conclusions that currently survive</h3>
        {body.conclusions.length === 0 ? (
          <p className="muted">No conclusion survived the review.</p>
        ) : (
          <ul className="traced-list">
            {body.conclusions.map((conclusion) => (
              <li key={conclusion.itemId}>
                <ToneChip tone={CONFIDENCE_TONES[conclusion.confidence]} title="Confidence">
                  {conclusion.confidence}
                </ToneChip>{' '}
                <TracedLine
                  line={{ text: conclusion.text, refs: [conclusion.itemId, ...conclusion.refs] }}
                  items={items}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <LineSection title="Evidence" lines={body.evidence} items={items} />
      <LineSection title="Open questions" lines={body.openQuestions} items={items} />

      <section className="synthesis-section">
        <h3>Tangents archived</h3>
        {body.archivedTangents.length === 0 ? (
          <p className="muted">No tangents were set aside.</p>
        ) : (
          <ul className="traced-list">
            {body.archivedTangents.map((tangent) => (
              <li key={tangent.itemId}>
                <TracedLine line={{ text: tangent.reason, refs: [tangent.itemId] }} items={items} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function SynthesisTab({ idea }: { idea: IdeaDto }) {
  const [params, setParams] = useSearchParams();
  const latest = idea.latestSynthesisVersion;
  const requested = Number(params.get('version'));
  const version =
    latest !== null && Number.isInteger(requested) && requested >= 1 && requested < latest
      ? requested
      : undefined;
  const synthesis = useSynthesis(idea.id, version);

  const selectVersion = (next: number) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === latest) updated.delete('version');
      else updated.set('version', String(next));
      return updated;
    });
  };

  if (synthesis.isPending) return <Loading />;
  if (synthesis.error) return <ErrorNote error={synthesis.error} />;
  if (!synthesis.data || latest === null) {
    return (
      <EmptyState title="No synthesis yet">
        The synthesis is built only after your review. Work through the items that need you in the
        Review tab, then choose “Build synthesis” on the Overview tab.
      </EmptyState>
    );
  }

  const data = synthesis.data;
  const versions = Array.from({ length: latest }, (_, index) => latest - index);
  return (
    <article className="synthesis">
      <header className="synthesis-meta">
        <span className="badge status-synthesis">Synthesis v{data.version}</span>
        {data.version !== latest && <span className="chip tone-warn">Earlier version</span>}
        <span className="muted">
          {data.provider} · {data.model} · {formatTime(data.createdAt)}
        </span>
        {versions.length > 1 && (
          <label className="version-select">
            Version{' '}
            <select value={data.version} onChange={(e) => selectVersion(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v} value={v}>
                  v{v}
                  {v === latest ? ' (latest)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      <SynthesisBody synthesis={data} />
    </article>
  );
}
