import type { IdeaDto } from '../../../src/api-types';
import { EventLog } from '../components/EventLog';
import { ErrorNote, Loading } from '../components/Feedback';
import { PASS_LABELS, formatTime } from '../labels';
import { useEvents, useRuns } from '../queries';

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
          <th>Provider</th>
          <th>Model</th>
          <th>Prompt version</th>
          <th>Status</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        {runs.data.map((run) => (
          <tr key={run.id}>
            <td>{PASS_LABELS[run.pass]}</td>
            <td>{run.provider}</td>
            <td>{run.model}</td>
            <td>{run.promptVersion}</td>
            <td>
              <span className={`chip tone-${run.status === 'completed' ? 'good' : 'bad'}`}>
                {run.status}
              </span>
              {run.error && <div className="error-note">{run.error}</div>}
            </td>
            <td className="muted">{formatTime(run.startedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HistoryTab({ idea }: { idea: IdeaDto }) {
  const events = useEvents(idea.id);
  return (
    <div className="history">
      <section>
        <h2>AI passes</h2>
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
