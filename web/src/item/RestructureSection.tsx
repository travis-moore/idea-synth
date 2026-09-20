import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ItemDetailDto, ItemDto } from '../../../src/api-types';
import { LIVE_STATUSES } from '../../../src/domain/vocabulary';
import type { ItemKind } from '../../../src/domain/vocabulary';
import { api } from '../api';
import type { BranchInput, ChildInput, MergeInput, ReviseInput, SupersedeInput } from '../api';
import { ErrorNote, Loading } from '../components/Feedback';
import { KindSelect } from '../components/KindSelect';
import { useOpenItem } from '../itemNavigation';
import { KIND_LABELS, truncate } from '../labels';
import { useAction, useGraph } from '../queries';

const STRUCTURAL_STATUSES: readonly ItemDto['status'][] = ['split', 'merged', 'superseded'];

function SubForm({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <details className="sub-form">
      <summary>{title}</summary>
      <p className="hint">{hint}</p>
      {children}
    </details>
  );
}

function SplitForm({ item }: { item: ItemDto }) {
  const blank: ChildInput = { text: '' };
  const [parts, setParts] = useState<ChildInput[]>([blank, blank]);
  const [rationale, setRationale] = useState('');
  const split = useAction((body: { children: ChildInput[]; rationale?: string }) =>
    api.splitItem(item.id, body),
  );
  const update = (index: number, patch: Partial<ChildInput>) =>
    setParts((current) => current.map((part, i) => (i === index ? { ...part, ...patch } : part)));
  const ready = parts.every((part) => part.text.trim().length > 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    split.mutate({ children: parts, rationale: rationale.trim() || undefined });
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      {parts.map((part, index) => (
        <div key={index} className="split-part">
          <label className="grow">
            Part {index + 1}
            <textarea
              rows={2}
              value={part.text}
              onChange={(e) => update(index, { text: e.target.value })}
            />
          </label>
          <KindSelect
            value={part.kind}
            onChange={(kind) => update(index, { kind })}
            defaultLabel="Same kind as this item"
            ariaLabel={`Kind of part ${index + 1}`}
          />
          {parts.length > 2 && (
            <button
              type="button"
              className="ghost"
              aria-label={`Remove part ${index + 1}`}
              onClick={() => setParts((current) => current.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <label>
        Why split? (optional)
        <input type="text" value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </label>
      <div className="form-actions">
        <button
          type="button"
          disabled={parts.length >= 12}
          onClick={() => setParts((current) => [...current, blank])}
        >
          + Add part
        </button>
        <button type="submit" className="primary" disabled={!ready || split.isPending}>
          Split into {parts.length} parts
        </button>
      </div>
      <ErrorNote error={split.error} />
    </form>
  );
}

function BranchForm({ item }: { item: ItemDto }) {
  const openItem = useOpenItem();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ItemKind | undefined>(undefined);
  const [asTangent, setAsTangent] = useState(false);
  const branch = useAction(
    (body: BranchInput) => api.branchItem(item.id, body),
    (created: ItemDetailDto) => openItem(created.item.id),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    branch.mutate({ text, kind, asTangent });
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      <label>
        Your new thought
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="form-row">
        <KindSelect
          value={kind}
          onChange={setKind}
          defaultLabel={asTangent ? 'Question (default)' : 'Hypothesis (default)'}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={asTangent}
            onChange={(e) => setAsTangent(e.target.checked)}
          />
          This is a tangent
        </label>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!text.trim() || branch.isPending}>
          Add branch
        </button>
      </div>
      <ErrorNote error={branch.error} />
    </form>
  );
}

function RewordForm({ item }: { item: ItemDto }) {
  const [text, setText] = useState(item.text);
  const [reason, setReason] = useState('');
  const revise = useAction(
    (body: ReviseInput) => api.reviseItem(item.id, body),
    () => setReason(''),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    revise.mutate({ text, reason: reason.trim() || undefined });
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      <label>
        New wording
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label>
        Reason (optional)
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="form-actions">
        <button
          type="submit"
          className="primary"
          disabled={!text.trim() || text.trim() === item.text.trim() || revise.isPending}
        >
          Save as new revision
        </button>
      </div>
      <ErrorNote error={revise.error} />
    </form>
  );
}

function SupersedeForm({ item }: { item: ItemDto }) {
  const openItem = useOpenItem();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ItemKind | undefined>(undefined);
  const [reason, setReason] = useState('');
  const supersede = useAction(
    (body: SupersedeInput) => api.supersedeItem(item.id, body),
    (replacement: ItemDetailDto) => openItem(replacement.item.id),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    supersede.mutate({ text, kind, reason: reason.trim() || undefined });
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      <label>
        New formulation
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="form-row">
        <KindSelect value={kind} onChange={setKind} defaultLabel="Same kind as this item" />
        <label className="grow">
          Reason (optional)
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!text.trim() || supersede.isPending}>
          Replace this item
        </button>
      </div>
      <ErrorNote error={supersede.error} />
    </form>
  );
}

function MergeForm({ item }: { item: ItemDto }) {
  const openItem = useOpenItem();
  const graph = useGraph(item.ideaId);
  const [otherIds, setOtherIds] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [rationale, setRationale] = useState('');
  const merge = useAction(api.mergeItems, (merged: ItemDetailDto) => openItem(merged.item.id));

  const candidates = (graph.data?.nodes ?? []).filter(
    (other) =>
      other.id !== item.id &&
      other.kind !== 'original_idea' &&
      other.kind !== 'synthesis' &&
      LIVE_STATUSES.includes(other.status),
  );
  const toggle = (id: string, checked: boolean) =>
    setOtherIds((current) => (checked ? [...current, id] : current.filter((x) => x !== id)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: MergeInput = {
      itemIds: [item.id, ...otherIds],
      text,
      rationale: rationale.trim() || undefined,
    };
    merge.mutate(body);
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      {graph.isPending && <Loading />}
      <ErrorNote error={graph.error} />
      <fieldset className="merge-candidates">
        <legend>Merge this item with…</legend>
        {candidates.length === 0 && (
          <p className="muted">There are no other live items to merge with.</p>
        )}
        {candidates.map((other) => (
          <label key={other.id} className="check">
            <input
              type="checkbox"
              checked={otherIds.includes(other.id)}
              onChange={(e) => toggle(other.id, e.target.checked)}
            />
            <span>
              <span className="muted">{KIND_LABELS[other.kind]}:</span> {truncate(other.text, 90)}
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        The merged statement, in your words
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label>
        Why merge? (optional)
        <input type="text" value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </label>
      <div className="form-actions">
        <button
          type="submit"
          className="primary"
          disabled={otherIds.length === 0 || !text.trim() || merge.isPending}
        >
          Merge {otherIds.length + 1} items
        </button>
      </div>
      <ErrorNote error={merge.error} />
    </form>
  );
}

/** Structural edits. Everything created here is authored by the user and recorded as such. */
export function RestructureSection({ item }: { item: ItemDto }) {
  if (item.kind === 'synthesis') return null;
  const isRoot = item.kind === 'original_idea';
  const isStructural = STRUCTURAL_STATUSES.includes(item.status);

  return (
    <details className="panel-section collapsible">
      <summary>Restructure</summary>
      <p className="hint">
        What you write here is recorded as yours. The earlier version is never lost.
      </p>
      <SubForm
        title="Branch"
        hint="Add a new hypothesis, question, correction… that arises from this item."
      >
        <BranchForm item={item} />
      </SubForm>
      {!isRoot && !isStructural && (
        <>
          <SubForm
            title="Split into parts"
            hint="This item bundles several claims. Separate them so each can be judged alone."
          >
            <SplitForm item={item} />
          </SubForm>
          <SubForm
            title="Reword"
            hint="Same thought, better words. Saved as a new revision of this item."
          >
            <RewordForm item={item} />
          </SubForm>
          <SubForm
            title="Replace with new formulation"
            hint="The thought itself has changed. This item is superseded by a new one."
          >
            <SupersedeForm item={item} />
          </SubForm>
          <SubForm
            title="Merge with other items"
            hint="Several items say the same thing. Combine them into one statement of yours."
          >
            <MergeForm item={item} />
          </SubForm>
        </>
      )}
    </details>
  );
}
