import { useState } from 'react';
import type { JobDto } from '../../../src/api-types';
import { api } from '../api';
import { useOpenItem } from '../itemNavigation';
import { formatElapsed, jobElapsedMs, selectJobsToShow } from '../jobs';
import type { JobScope } from '../jobs';
import { JOB_KIND_LABELS, JOB_STATUS_LABELS } from '../labels';
import { useLiveState } from '../live/useLive';
import { useAction, useCanReason, useJobs } from '../queries';
import { ErrorNote } from './Feedback';

/** Dismissed problem jobs, kept for the page's lifetime so a tab switch does not bring them back. */
const dismissedJobIds = new Set<string>();

/** Re-issue the request that created this job. Null when that needs the user's own input again. */
function retryRequest(job: JobDto): (() => Promise<unknown>) | null {
  const { sessionId } = job;
  switch (job.kind) {
    case 'analyze':
      return () => api.analyze(job.ideaId);
    case 'synthesize':
      // No override is re-sent: if items still need the user, the gate answers and explains.
      return () => api.synthesize(job.ideaId);
    case 'guided_turn':
      return sessionId ? () => api.continueGuided(sessionId) : null;
    case 'guided_handoff':
      return sessionId ? () => api.handOffGuided(sessionId) : null;
    case 'discuss_reply':
      return null;
  }
}

function ActiveJob({ job, now }: { job: JobDto; now: number }) {
  const cancel = useAction(() => api.cancelJob(job.id));
  const stopping = job.cancelRequested || cancel.isPending;
  return (
    <li className={`job job-${job.status}`}>
      <span className="job-pulse" aria-hidden="true" />
      <span className="job-main">
        <strong className="job-kind">{JOB_KIND_LABELS[job.kind]}</strong>
        <span className="job-status">
          {stopping ? 'Stopping…' : JOB_STATUS_LABELS[job.status]}
          {job.attempts > 1 && ` · attempt ${job.attempts}`}
        </span>
        {job.progress && <span className="job-progress">{job.progress}</span>}
        <span className="job-elapsed muted">{formatElapsed(jobElapsedMs(job, now))}</span>
      </span>
      <button
        type="button"
        className="job-action"
        disabled={stopping}
        onClick={() => cancel.mutate(undefined)}
      >
        Cancel
      </button>
      <ErrorNote error={cancel.error} />
    </li>
  );
}

function ProblemJob({ job, onDismiss }: { job: JobDto; onDismiss: () => void }) {
  const canReason = useCanReason();
  const openItem = useOpenItem();
  const request = retryRequest(job);
  const retry = useAction(() => (request ? request() : Promise.resolve(null)), onDismiss);
  const { itemId } = job;
  return (
    <li className={`job job-${job.status}`}>
      <span className="job-main">
        <strong className="job-kind">{JOB_KIND_LABELS[job.kind]}</strong>
        <span className="job-status">{JOB_STATUS_LABELS[job.status]}</span>
        <span className="job-error">
          {job.error ?? 'It did not finish. Nothing was applied to your reasoning.'}
        </span>
      </span>
      <span className="job-buttons">
        {canReason && request && (
          <button
            type="button"
            className="job-action"
            disabled={retry.isPending}
            onClick={() => retry.mutate(undefined)}
          >
            {retry.isPending ? 'Queueing…' : 'Retry'}
          </button>
        )}
        {job.kind === 'discuss_reply' && itemId && (
          <button type="button" className="job-action" onClick={() => openItem(itemId)}>
            Open item to ask again
          </button>
        )}
        <button type="button" className="job-action ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </span>
      <ErrorNote error={retry.error} />
    </li>
  );
}

interface JobStripProps extends JobScope {
  ideaId: string;
}

/**
 * Compact status of web-triggered reasoning for one idea (or one guided session): what is
 * queued or running, with Cancel, and the last job that did not finish, with Retry.
 * Renders nothing when there is nothing to say. State survives reloads: it is read from the API.
 */
export function JobStrip({ ideaId, sessionId, itemId }: JobStripProps) {
  const jobs = useJobs(ideaId);
  const live = useLiveState();
  const [, setDismissedCount] = useState(0);
  const scope: JobScope = {};
  if (sessionId !== undefined) scope.sessionId = sessionId;
  if (itemId !== undefined) scope.itemId = itemId;
  const { active, problem } = selectJobsToShow(jobs.data ?? [], scope);
  const shownProblem = problem && !dismissedJobIds.has(problem.id) ? problem : null;
  if (active.length === 0 && !shownProblem) return null;

  // While jobs run the poller advances `live.now` every couple of seconds: no timer here.
  const now = Math.max(live.now, Date.now() - 2_500);
  return (
    <ul className="job-strip" aria-label="Reasoning jobs" aria-live="polite">
      {active.map((job) => (
        <ActiveJob key={job.id} job={job} now={now} />
      ))}
      {shownProblem && (
        <ProblemJob
          key={shownProblem.id}
          job={shownProblem}
          onDismiss={() => {
            dismissedJobIds.add(shownProblem.id);
            setDismissedCount((count) => count + 1);
          }}
        />
      )}
    </ul>
  );
}
