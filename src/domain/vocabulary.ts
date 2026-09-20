/**
 * The controlled vocabulary of Idea Synth.
 *
 * Everything here is pure data: no persistence, HTTP or AI imports. Both the server and
 * the web client import this file, so the UI, the API and the database agree on one
 * set of names. When you add a value, also update docs/domain-model.md.
 */
import { z } from 'zod';

/** Who wrote the words of something. There is deliberately no "both". */
export const AUTHORS = ['user', 'agent'] as const;
export type Author = (typeof AUTHORS)[number];
export const authorSchema = z.enum(AUTHORS);

/** Actors that can appear in the audit log. `system` is the application itself. */
export const ACTORS = ['user', 'agent', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

/**
 * Where a reasoning item's *content* came from. Immutable once written.
 *
 * - `user`                 The user's own words (captured idea, user-written items, guided answers).
 * - `extracted_from_user`  The agent's restatement of something the user said, linked to the
 *                          source passage. The thought is the user's; the wording is the agent's.
 * - `agent`                Thought up by the agent: implications, extensions, objections,
 *                          corrections, supplied premises, syntheses.
 *
 * A user *accepting* an agent item never changes its origin. Acceptance is a decision,
 * recorded separately.
 */
export const ORIGINS = ['user', 'extracted_from_user', 'agent'] as const;
export type Origin = (typeof ORIGINS)[number];
export const originSchema = z.enum(ORIGINS);

/** What a reasoning item *is*. */
export const ITEM_KINDS = [
  'original_idea',
  'factual_claim',
  'causal_claim',
  'hypothesis',
  'assumption',
  'analogy',
  'value_judgment',
  'definition',
  'question',
  'inference',
  'uncertainty',
  'implication',
  'extension',
  'objection',
  'correction',
  'evidence',
  'example',
  'test',
  'distinction',
  'conclusion',
  'synthesis',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const itemKindSchema = z.enum(ITEM_KINDS);

/** Kinds the extract pass may produce (Step 2). */
export const EXTRACTABLE_KINDS = [
  'factual_claim',
  'causal_claim',
  'hypothesis',
  'assumption',
  'analogy',
  'value_judgment',
  'definition',
  'question',
  'inference',
  'uncertainty',
] as const satisfies readonly ItemKind[];

/** Kinds a user may create by hand (split, branch, merge, supersede). */
export const USER_CREATABLE_KINDS: readonly ItemKind[] = ITEM_KINDS.filter(
  (k) => k !== 'original_idea' && k !== 'synthesis' && k !== 'conclusion',
);

/**
 * Where an item stands in the *current reasoning state*.
 *
 * `accepted` means "accepted into the current reasoning state", never "objectively true".
 */
export const ITEM_STATUSES = [
  'open',
  'needs_user',
  'accepted',
  'qualified',
  'rejected',
  'superseded',
  'merged',
  'split',
  'tangent',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const itemStatusSchema = z.enum(ITEM_STATUSES);

/** Statuses that still take part in the main line of reasoning. */
export const LIVE_STATUSES: readonly ItemStatus[] = ['open', 'needs_user', 'accepted', 'qualified'];
/** Statuses for which no conclusion has been reached. */
export const UNRESOLVED_STATUSES: readonly ItemStatus[] = ['open', 'needs_user'];
/** Live statuses plus tangents: the item is still "worth something". */
export const PRODUCTIVE_STATUSES: readonly ItemStatus[] = [...LIVE_STATUSES, 'tangent'];

/** Decisions that can be recorded against an item. Each is an append-only row. */
export const DECISION_TYPES = [
  'accept',
  'qualify',
  'reject',
  'reopen',
  'flag_needs_user',
  'mark_tangent',
  'split',
  'merge',
  'supersede',
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];
export const decisionTypeSchema = z.enum(DECISION_TYPES);

/** Epistemic verdicts from the fact-check / epistemic review (Step 4). */
export const EPISTEMIC_VERDICTS = [
  'well_supported',
  'plausible_uncertain',
  'disputed',
  'unsupported',
  'misleading_framing',
  'probably_false',
  'false',
  'normative',
  'requires_clarification',
] as const;
export type EpistemicVerdict = (typeof EPISTEMIC_VERDICTS)[number];
export const epistemicVerdictSchema = z.enum(EPISTEMIC_VERDICTS);

/** Verdicts meaning "this premise did not survive scrutiny". */
export const FAILED_VERDICTS: readonly EpistemicVerdict[] = ['probably_false', 'false'];

/**
 * Semantic edge types. An edge reads `from --type--> to`.
 *
 * `flow` says how the edge relates to the order in which thoughts arose, which the
 * map uses for layout: `forward` means `from` came first (parent -> child), `reverse`
 * means `to` came first (the edge points back at what it is about).
 *
 * `genealogical` edges describe where an item came from. They must never form a
 * cycle, and they are what "productive child of a false premise" is computed over.
 */
export const RELATION_TYPES = {
  derived_from: { flow: 'reverse', genealogical: true, label: 'derived from' },
  branches_to: { flow: 'forward', genealogical: true, label: 'branches to' },
  tangent_of: { flow: 'reverse', genealogical: true, label: 'tangent of' },
  supersedes: { flow: 'reverse', genealogical: true, label: 'supersedes' },
  merged_into: { flow: 'forward', genealogical: true, label: 'merged into' },
  synthesized_into: { flow: 'forward', genealogical: true, label: 'synthesised into' },
  answers: { flow: 'reverse', genealogical: true, label: 'answers' },
  supports: { flow: 'reverse', genealogical: false, label: 'supports' },
  contradicts: { flow: 'reverse', genealogical: false, label: 'contradicts' },
  qualifies: { flow: 'reverse', genealogical: false, label: 'qualifies' },
  questions: { flow: 'reverse', genealogical: false, label: 'questions' },
  corrects: { flow: 'reverse', genealogical: false, label: 'corrects' },
  assumes: { flow: 'forward', genealogical: false, label: 'assumes' },
  evidence_for: { flow: 'reverse', genealogical: false, label: 'evidence for' },
  evidence_against: { flow: 'reverse', genealogical: false, label: 'evidence against' },
} as const satisfies Record<
  string,
  { flow: 'forward' | 'reverse'; genealogical: boolean; label: string }
>;
export type RelationType = keyof typeof RELATION_TYPES;
export const RELATION_TYPE_NAMES = Object.keys(RELATION_TYPES) as [RelationType, ...RelationType[]];
export const relationTypeSchema = z.enum(RELATION_TYPE_NAMES);

/**
 * Edge types that make `from` a *product* of `to` being thought about at all: if `to`
 * later fails, `from` can still be a productive idea that arose from it.
 */
export const ARISES_FROM_TYPES: readonly RelationType[] = [
  'derived_from',
  'tangent_of',
  'questions',
  'answers',
];

/** Lifecycle of an idea through the eight-stage workflow. */
export const IDEA_STAGES = ['guided', 'captured', 'in_review', 'synthesized'] as const;
export type IdeaStage = (typeof IDEA_STAGES)[number];

/** How an idea came to exist. */
export const IDEA_SOURCES = ['captured', 'guided', 'promoted_tangent'] as const;
export type IdeaSource = (typeof IDEA_SOURCES)[number];

/** Reasoning passes. Each run of one is an `analysis_runs` row. */
export const PASSES = [
  'extract',
  'explore',
  'epistemic',
  'adversarial',
  'builder',
  'synthesize',
  'discuss',
  'tutor',
] as const;
export type Pass = (typeof PASSES)[number];

/** The three reasoning roles, and which passes embody them. */
export const ROLE_OF_PASS: Record<Pass, 'explorer' | 'skeptic' | 'builder' | 'tutor' | 'neutral'> =
  {
    extract: 'neutral',
    explore: 'explorer',
    epistemic: 'skeptic',
    adversarial: 'skeptic',
    builder: 'builder',
    synthesize: 'builder',
    discuss: 'neutral',
    tutor: 'tutor',
  };

/**
 * Pre-gate analysis order (Steps 2-5). Explorer runs before either sceptical pass on
 * purpose: premature criticism kills branches before they are captured.
 */
export const ANALYSIS_PASS_ORDER = ['extract', 'explore', 'epistemic', 'adversarial'] as const;
/** Post-gate order (Steps 6-8; the tangent archive is part of the synthesize pass). */
export const SYNTHESIS_PASS_ORDER = ['builder', 'synthesize'] as const;

/** Why an item is in the inbox. */
export const ATTENTION_REASONS = [
  'clarification_needed',
  'unresolved_objection',
  'disputed_correction',
  'unresolved_assumption',
  'value_judgment_input',
  'ambiguous_interpretation',
  'premise_needs_response',
  'decision_required',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];
export const attentionReasonSchema = z.enum(ATTENTION_REASONS);

/** Audit-log event types. */
export const EVENT_TYPES = [
  'idea.captured',
  'idea.stage_changed',
  'idea.promoted_from_tangent',
  'run.started',
  'run.completed',
  'run.failed',
  'run.stale',
  'item.created',
  'item.revised',
  'item.assessed',
  'item.decided',
  'item.split',
  'item.merged',
  'item.superseded',
  'item.branched',
  'item.promoted',
  'relation.created',
  'message.posted',
  'evidence.attached',
  'gate.overridden',
  'synthesis.created',
  'guided.started',
  'guided.step',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
