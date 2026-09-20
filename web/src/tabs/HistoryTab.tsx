import type { IdeaDto, RunDto } from '../../../src/api-types';
import { EventLog } from '../components/EventLog';
import { ErrorNote, Loading } from '../components/Feedback';
import { PASS_LABELS, describeAuthMode, describeModelSource, formatTime } from '../labels';
import type { Tone } from '../labels';
import { useEvents, useRuns } from '../queries';

const RUN_TONES: Record<RunDto['status'], Tone> = {
  completed: 'good',
  failed: 'bad',
  stale: 'warn',
};

function RunsTable({ ideaId }: { ideaId: string }) {
  const runs = useRuns(ideaId);
  if (runs.isPending) return <Loading />;
  if (runs.error) return <ErrorNote error={runs.error} />;
  if (runs.data.length === 0)
    return <p className="muted">No AI passes have run on this idea yet.</p>;
  return (
    <table className="runs-table">
      <thead>
        <tr>
          <th>Pass</th>
          <th>Produced by</th>
          <th>Prompt version</th>
          <th>Status</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        {runs.data.map((run) => {
          const source = describeModelSource(run.modelSource);
          const auth = describeAuthMode(run.authMode);
          return (
            <tr key={run.id} className={`run-${run.status}`}>
              <td data-label="Pass">{PASS_LABELS[run.pass]}</td>
              <td data-label="Produced by">
                <span className="run-model">
                  {run.provider} · {run.model}
                </span>
                {(source || auth) && (
                  <span className="run-chips">
                    {source && <span className="chip tone-neutral">{source}</span>}
                    {auth && <span className="chip tone-neutral">{auth}</span>}
                  </span>
                )}
              </td>
              <td data-label="Prompt version">
                {run.promptVersion}
                {run.inputVersion !== null && (
                  <span className="muted" title="The idea revision this pass was given as input">
                    {' '}
                    · input r{run.inputVersion}
                  </span>
                )}
              </td>
              <td data-label="Status">
                <span className={`chip tone-${RUN_TONES[run.status]}`}>{run.status}</span>
                {run.status === 'stale' && (
                  <div className="hint run-note">
                    Not applied: the idea changed while this was generated.
                  </div>
                )}
                {run.error && <div className="error-note">{run.error}</div>}
              </td>
              <td data-label="Started" className="muted">
                {formatTime(run.startedAt)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function HistoryTab({ idea }: { idea: IdeaDto }) {
  const events = useEvents(idea.id);
  return (
    <div className="history">
      <section>
        <h2>Reasoning passes</h2>
        <RunsTable ideaId={idea.id} />
      </section>
      <section>
        <h2>Audit log</h2>
        <p className="hint">
          Everything that happened to this idea, in order. Nothing is ever deleted.
        </p>
        {events.isPending && <Loading />}
        <ErrorNote error={events.error} />
        {events.data && <EventLog events={events.data} />}
      </section>
    </div>
  );
}
