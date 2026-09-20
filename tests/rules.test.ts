import { describe, expect, it } from 'vitest';
import {
  evaluateReviewGate,
  productiveDescendants,
  statusAfterDecision,
  wouldCreateGenealogyCycle,
  type EdgeLike,
  type ItemLike,
} from '../src/domain/rules';
import { newId } from '../src/domain/ids';

describe('statusAfterDecision', () => {
  const base = { kind: 'hypothesis', status: 'open', author: 'user' } as const;
  it('maps decisions to statuses', () => {
    expect(statusAfterDecision({ ...base, decision: 'accept' })).toBe('accepted');
    expect(statusAfterDecision({ ...base, decision: 'reject' })).toBe('rejected');
    expect(statusAfterDecision({ ...base, decision: 'mark_tangent' })).toBe('tangent');
    expect(statusAfterDecision({ ...base, status: 'rejected', decision: 'reopen' })).toBe('open');
  });
  it('requires a qualification for a qualified acceptance', () => {
    expect(() =>
      statusAfterDecision({ ...base, decision: 'qualify', qualification: '  ' }),
    ).toThrow(/qualification/);
    expect(
      statusAfterDecision({ ...base, decision: 'qualify', qualification: 'only in cities' }),
    ).toBe('qualified');
  });
  it('protects the original idea and process records', () => {
    expect(() =>
      statusAfterDecision({ ...base, kind: 'original_idea', decision: 'reject' }),
    ).toThrow();
    expect(() =>
      statusAfterDecision({ ...base, kind: 'original_idea', decision: 'supersede' }),
    ).toThrow();
    expect(() => statusAfterDecision({ ...base, kind: 'synthesis', decision: 'accept' })).toThrow();
    expect(
      statusAfterDecision({ ...base, kind: 'synthesis', decision: 'supersede', author: 'agent' }),
    ).toBe('superseded');
  });
  it('stops the agent from making judgement calls', () => {
    for (const decision of ['accept', 'qualify', 'reject', 'reopen', 'split', 'merge'] as const)
      expect(() =>
        statusAfterDecision({ ...base, decision, author: 'agent', qualification: 'x' }),
      ).toThrow(/belongs to the user/);
    expect(statusAfterDecision({ ...base, decision: 'flag_needs_user', author: 'agent' })).toBe(
      'needs_user',
    );
    expect(() =>
      statusAfterDecision({ ...base, decision: 'supersede', author: 'agent' }),
    ).toThrow();
  });
});

describe('genealogy', () => {
  const edges: EdgeLike[] = [
    { fromItemId: 'b', toItemId: 'a', type: 'derived_from' }, // a -> b
    { fromItemId: 'b', toItemId: 'c', type: 'branches_to' }, // b -> c
  ];
  it('detects cycles across edge types that read in opposite directions', () => {
    expect(
      wouldCreateGenealogyCycle(edges, { fromItemId: 'a', toItemId: 'c', type: 'derived_from' }),
    ).toBe(true);
    expect(
      wouldCreateGenealogyCycle(edges, { fromItemId: 'c', toItemId: 'a', type: 'branches_to' }),
    ).toBe(true);
    expect(
      wouldCreateGenealogyCycle(edges, { fromItemId: 'd', toItemId: 'c', type: 'derived_from' }),
    ).toBe(false);
  });
  it('ignores non-genealogical edges, which may legitimately be mutual', () => {
    expect(
      wouldCreateGenealogyCycle(edges, { fromItemId: 'a', toItemId: 'c', type: 'contradicts' }),
    ).toBe(false);
  });
});

describe('productiveDescendants', () => {
  const item = (
    id: string,
    status: ItemLike['status'],
    verdict: ItemLike['epistemicVerdict'] = null,
  ): ItemLike => ({
    id,
    status,
    epistemicVerdict: verdict,
  });
  it('finds survivors through a dead intermediate, and ignores dead ends', () => {
    const items = [
      item('p', 'rejected'),
      item('mid', 'rejected'),
      item('leaf', 'tangent'),
      item('dead', 'rejected'),
    ];
    const edges: EdgeLike[] = [
      { fromItemId: 'mid', toItemId: 'p', type: 'derived_from' },
      { fromItemId: 'leaf', toItemId: 'mid', type: 'tangent_of' },
      { fromItemId: 'dead', toItemId: 'p', type: 'derived_from' },
    ];
    expect(productiveDescendants('p', items, edges)).toEqual(['leaf']);
  });
  it('does not count objections or corrections aimed at the premise', () => {
    const items = [item('p', 'rejected'), item('objection', 'accepted'), item('fix', 'accepted')];
    const edges: EdgeLike[] = [
      { fromItemId: 'objection', toItemId: 'p', type: 'contradicts' },
      { fromItemId: 'fix', toItemId: 'p', type: 'corrects' },
    ];
    expect(productiveDescendants('p', items, edges)).toEqual([]);
  });
});

describe('review gate', () => {
  it('blocks on needs_user only; open items pass through as open questions', () => {
    const gate = evaluateReviewGate([
      { id: 'root', status: 'open', kind: 'original_idea' },
      { id: 'a', status: 'needs_user', kind: 'objection' },
      { id: 'b', status: 'open', kind: 'question' },
      { id: 'c', status: 'accepted', kind: 'hypothesis' },
    ]);
    expect(gate).toEqual({ blockingItemIds: ['a'], openItemIds: ['b'], canProceed: false });
  });
});

describe('ids', () => {
  it('are sortable in creation order even within one millisecond', () => {
    const ids = Array.from({ length: 500 }, () => newId('itm'));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
