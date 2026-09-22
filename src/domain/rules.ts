/**
 * Pure reasoning rules. No I/O: everything here is unit-testable with plain objects.
 */
import { invalid, forbidden } from './errors';
import {
  ARISES_FROM_TYPES,
  FAILED_VERDICTS,
  PRODUCTIVE_STATUSES,
  RELATION_TYPES,
  type Author,
  type DecisionType,
  type EpistemicVerdict,
  type ItemKind,
  type ItemStatus,
  type RelationType,
} from './vocabulary';

// ---------------------------------------------------------------------------
// Decisions and status transitions
// ---------------------------------------------------------------------------

/** Statuses created by structural operations. Children exist, so they are final. */
const STRUCTURAL_STATUSES: readonly ItemStatus[] = ['split', 'merged', 'superseded'];

/** Kinds that are records of the process itself and cannot be accepted/rejected directly. */
const UNDECIDABLE_KINDS: readonly ItemKind[] = ['original_idea', 'synthesis'];

const DECISION_TARGET: Record<DecisionType, ItemStatus> = {
  accept: 'accepted',
  qualify: 'qualified',
  respond: 'responded',
  reject: 'rejected',
  reopen: 'open',
  flag_needs_user: 'needs_user',
  mark_tangent: 'tangent',
  split: 'split',
  merge: 'merged',
  supersede: 'superseded',
};

/**
 * The agent may ask for attention or set something aside as a tangent. Both are
 * non-destructive and reversible. Judgement calls (accept, qualify, reject) and
 * structural changes belong to the user.
 */
const AGENT_ALLOWED: readonly DecisionType[] = ['flag_needs_user', 'mark_tangent'];

export interface DecisionInput {
  kind: ItemKind;
  status: ItemStatus;
  decision: DecisionType;
  author: Author;
  qualification?: string | null | undefined;
  /** For `respond`: the user's answer, in their words. */
  response?: string | null | undefined;
}

/** Validate a decision and return the status it leads to. Throws DomainError if not allowed. */
export function statusAfterDecision(input: DecisionInput): ItemStatus {
  const { kind, status, decision, author } = input;
  // The agent may retire its own process records (an older synthesis and its conclusions).
  const agentRetiringOwnRecord =
    author === 'agent' &&
    decision === 'supersede' &&
    (kind === 'synthesis' || kind === 'conclusion');
  if (author === 'agent' && !AGENT_ALLOWED.includes(decision) && !agentRetiringOwnRecord) {
    throw forbidden(`The agent may not record a "${decision}" decision; that belongs to the user.`);
  }
  if (UNDECIDABLE_KINDS.includes(kind) && !agentRetiringOwnRecord) {
    // A synthesis is replaced by building a new version, never by hand: otherwise the
    // next synthesis run could not retire it and the idea would be stuck at this version.
    throw invalid(`Items of kind "${kind}" are records of the process and cannot be decided on.`);
  }
  if (kind === 'original_idea') {
    throw invalid('The original idea is permanent provenance and cannot be superseded.');
  }
  if (STRUCTURAL_STATUSES.includes(status)) {
    throw invalid(`Item is already ${status}; continue with the items it produced.`);
  }
  if (decision === 'respond' && !input.response?.trim()) {
    throw invalid("A response needs the user's words.");
  }
  if (decision === 'qualify' && !input.qualification?.trim()) {
    throw invalid('A qualified acceptance needs the qualification spelled out.');
  }
  const target = DECISION_TARGET[decision];
  if (target === status && decision !== 'qualify' && decision !== 'respond') {
    throw invalid(`Item is already ${status}.`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Graph rules
// ---------------------------------------------------------------------------

export interface EdgeLike {
  fromItemId: string;
  toItemId: string;
  type: RelationType;
}

/**
 * Normalise a genealogical edge to (ancestor, descendant) regardless of which way the
 * relation type reads. Returns null for non-genealogical edges.
 */
export function genealogyPair(edge: EdgeLike): { ancestor: string; descendant: string } | null {
  const meta = RELATION_TYPES[edge.type];
  if (!meta.genealogical) return null;
  return meta.flow === 'forward'
    ? { ancestor: edge.fromItemId, descendant: edge.toItemId }
    : { ancestor: edge.toItemId, descendant: edge.fromItemId };
}

/** Would adding `candidate` make some item its own ancestor? */
export function wouldCreateGenealogyCycle(existing: EdgeLike[], candidate: EdgeLike): boolean {
  const pair = genealogyPair(candidate);
  if (!pair) return false;
  if (pair.ancestor === pair.descendant) return true;
  const children = new Map<string, string[]>();
  for (const e of existing) {
    const p = genealogyPair(e);
    if (!p) continue;
    const list = children.get(p.ancestor) ?? [];
    list.push(p.descendant);
    children.set(p.ancestor, list);
  }
  // A cycle appears iff the new ancestor is already reachable from the new descendant.
  const stack = [pair.descendant];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === pair.ancestor) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(children.get(node) ?? []));
  }
  return false;
}

// ---------------------------------------------------------------------------
// "False premise, productive idea"
// ---------------------------------------------------------------------------

export interface ItemLike {
  id: string;
  status: ItemStatus;
  epistemicVerdict: EpistemicVerdict | null;
}

/** A premise has failed if the user rejected it or the epistemic review found it false. */
export function premiseFailed(item: ItemLike): boolean {
  return (
    item.status === 'rejected' ||
    (item.epistemicVerdict !== null && FAILED_VERDICTS.includes(item.epistemicVerdict))
  );
}

/**
 * Ids of items that arose from `itemId` (transitively) and are still productive.
 * Corrections and objections do not count: they are *about* the premise, not ideas
 * it generated.
 */
export function productiveDescendants(
  itemId: string,
  items: ItemLike[],
  edges: EdgeLike[],
): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const arisingFrom = new Map<string, string[]>();
  for (const e of edges) {
    let parent: string | null = null;
    let child: string | null = null;
    if (ARISES_FROM_TYPES.includes(e.type)) {
      parent = e.toItemId;
      child = e.fromItemId;
    } else if (e.type === 'branches_to') {
      parent = e.fromItemId;
      child = e.toItemId;
    }
    if (!parent || !child) continue;
    const list = arisingFrom.get(parent) ?? [];
    list.push(child);
    arisingFrom.set(parent, list);
  }
  const found: string[] = [];
  const seen = new Set<string>([itemId]);
  const stack = [...(arisingFrom.get(itemId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const item = byId.get(id);
    if (item && PRODUCTIVE_STATUSES.includes(item.status) && !premiseFailed(item)) found.push(id);
    stack.push(...(arisingFrom.get(id) ?? []));
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// Review gate (between Steps 5 and 6)
// ---------------------------------------------------------------------------

export interface ReviewGate {
  /** Items the agent has explicitly asked the user about. These block Steps 6-8. */
  blockingItemIds: string[];
  /** Items still open. They do not block; they surface as open questions in the synthesis. */
  openItemIds: string[];
  canProceed: boolean;
}

export function evaluateReviewGate(
  items: Array<{ id: string; status: ItemStatus; kind: ItemKind }>,
): ReviewGate {
  const reviewable = items.filter((i) => i.kind !== 'original_idea' && i.kind !== 'synthesis');
  const blockingItemIds = reviewable.filter((i) => i.status === 'needs_user').map((i) => i.id);
  const openItemIds = reviewable.filter((i) => i.status === 'open').map((i) => i.id);
  return { blockingItemIds, openItemIds, canProceed: blockingItemIds.length === 0 };
}
