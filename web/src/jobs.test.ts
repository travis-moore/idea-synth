import { describe, expect, it } from 'vitest';
import type { JobDto } from '../../src/api-types';
import { formatElapsed, jobElapsedMs, selectJobsToShow } from './jobs';

let counter = 0;
function job(partial: Partial<JobDto>): JobDto {
  counter += 1;
  return {
    id: `job_${counter}`,
    ideaId: 'idea_1',
    kind: 'analyze',
    status: 'completed',
    progress: null,
    errorCode: null,
    error: null,
    attempts: 1,
    cancelRequested: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    itemId: null,
    sessionId: null,
    ...partial,
  };
}

describe('selectJobsToShow (newest first)', () => {
  it('shows active jobs and the latest job that did not finish', () => {
    const failed = job({ status: 'failed', kind: 'synthesize', error: 'boom' });
    const running = job({ status: 'running' });
    const shown = selectJobsToShow([running, failed, job({ status: 'failed' })]);
    expect(shown.active).toEqual([running]);
    expect(shown.problem).toBe(failed);
  });

  it('forgets a failure once the same work was queued again', () => {
    const retried = job({ status: 'completed' });
    const failed = job({ status: 'failed' });
    expect(selectJobsToShow([retried, failed]).problem).toBeNull();
  });

  it('scopes to a guided session or an item', () => {
    const mine = job({ kind: 'guided_turn', status: 'queued', sessionId: 'gs_1' });
    const other = job({ kind: 'guided_turn', status: 'interrupted', sessionId: 'gs_2' });
    const reply = job({ kind: 'discuss_reply', status: 'running', itemId: 'item_1' });
    const all = [mine, other, reply];
    expect(selectJobsToShow(all, { sessionId: 'gs_1' })).toEqual({ active: [mine], problem: null });
    expect(selectJobsToShow(all, { sessionId: 'gs_2' }).problem).toBe(other);
    expect(selectJobsToShow(all, { itemId: 'item_1' }).active).toEqual([reply]);
  });
});

describe('elapsed time', () => {
  it('formats compactly', () => {
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(185_000)).toBe('3m 05s');
    expect(formatElapsed(3_720_000)).toBe('1h 02m');
    expect(formatElapsed(-5)).toBe('0s');
  });
  it('counts from the start (or from queueing) to the finish (or now)', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    expect(jobElapsedMs(job({ createdAt: at(0), startedAt: at(10) }), Date.parse(at(25)))).toBe(
      15_000,
    );
    expect(jobElapsedMs(job({ createdAt: at(0) }), Date.parse(at(4)))).toBe(4_000);
    expect(jobElapsedMs(job({ createdAt: at(0), startedAt: at(1), finishedAt: at(3) }), 0)).toBe(
      2_000,
    );
  });
});
