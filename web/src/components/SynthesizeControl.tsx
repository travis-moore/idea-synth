import { useState } from 'react';
import type { IdeaDto } from '../../../src/api-types';
import { api } from '../api';
import { VIEWER_MODE_HINT } from '../labels';
import { isActiveJob, useAction, useCanReason, useGraph, useJobs, useViewerMode } from '../queries';
import { ErrorNote } from './Feedback';
import { ItemChip, UnknownItemChip } from './ItemChip';

interface SynthesizeControlProps {
  idea: IdeaDto;
  label: string;
}

/**
 * Queues Steps 6-8 as a background job. When the review gate blocks, the server answers 409
 * and names the blocking items. "Proceed anyway" re-posts with exactly those ids: the
 * override is bound to what the user was shown, so an item that started needing them in the
 * meantime is never silently overridden (the server refuses again and names it).
 */
export function SynthesizeControl({ idea, label }: SynthesizeControlProps) {
  const canReason = useCanReason();
  const viewer = useViewerMode();
  const jobs = useJobs(idea.id);
  const graph = useGraph(idea.id);
  const [shownBlocking, setShownBlocking] = useState<string[] | null>(null);
  const synthesize = useAction(
    (overrideIds: string[] | undefined) => api.synthesize(idea.id, overrideIds),
    () => setShownBlocking(null),
  );
  const active = jobs.data?.find((job) => job.kind === 'synthesize' && isActiveJob(job));

  if (!canReason) return viewer ? <p className="viewer-note">{VIEWER_MODE_HINT}</p> : null;

  const queue = (overrideIds?: string[]) =>
    synthesize.mutate(overrideIds, {
      onError: (error) => {
        if (error.status !== 409) return;
        const blocking = error.detailIds('blockingItemIds');
        const uncovered = error.detailIds('uncoveredItemIds') ?? [];
        // Show the union, so a second "Proceed anyway" covers what the first one missed.
        if (blocking) setShownBlocking([...new Set([...blocking, ...uncovered])]);
      },
    });

  const gateBlocked = shownBlocking !== null && shownBlocking.length > 0;
  const busy = synthesize.isPending || active !== undefined;
  return (
    <div className="synthesize-control">
      <div className="form-actions">
        <button
          type="button"
          className={idea.gate.canProceed ? 'primary' : 'primary looks-disabled'}
          aria-describedby={idea.gate.canProceed ? undefined : 'gate-hint'}
          disabled={busy}
          onClick={() => queue()}
        >
          {active ? `Synthesis ${active.status === 'queued' ? 'queued' : 'running'}…` : label}
        </button>
        {gateBlocked && (
          <button
            type="button"
            className="warn"
            disabled={busy}
            onClick={() => queue(shownBlocking)}
          >
            Proceed anyway ({shownBlocking.length} unresolved)
          </button>
        )}
      </div>
      {!idea.gate.canProceed && !gateBlocked && (
        <p className="hint" id="gate-hint">
          The review gate is closed while items still need you. You can resolve them in the Review
          tab first.
        </p>
      )}
      <ErrorNote error={synthesize.error} />
      {gateBlocked && (
        <p className="refs" aria-label="Items that still need you">
          {shownBlocking.map((itemId) => {
            const item = graph.data?.nodes.find((node) => node.id === itemId);
            return item ? (
              <ItemChip key={itemId} item={item} />
            ) : (
              <UnknownItemChip key={itemId} itemId={itemId} />
            );
          })}
        </p>
      )}
      {gateBlocked && (
        <p className="hint">
          Proceeding overrides the review gate for the {shownBlocking.length}{' '}
          {shownBlocking.length === 1 ? 'item' : 'items'} that still{' '}
          {shownBlocking.length === 1 ? 'needs' : 'need'} you right now. They will be carried into
          the synthesis as open questions, and the override is recorded in the history.
        </p>
      )}
    </div>
  );
}
