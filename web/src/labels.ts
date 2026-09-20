/**
 * Human-readable labels for the controlled vocabulary (src/domain/vocabulary.ts).
 * Every Record is keyed by the domain type, so adding a value there is a compile error here.
 */
import type { Adequacy, PremiseStance } from '../../src/domain/scaffolding';
import type {
  Actor,
  AttentionReason,
  Author,
  DecisionType,
  EpistemicVerdict,
  IdeaSource,
  IdeaStage,
  ItemKind,
  ItemStatus,
  Origin,
  Pass,
} from '../../src/domain/vocabulary';

export const ORIGIN_LABELS: Record<Origin, string> = {
  user: 'User idea',
  extracted_from_user: 'From your words',
  agent: 'AI',
};

export const ORIGIN_CAPTIONS: Record<Origin, string | null> = {
  user: null,
  extracted_from_user: 'Extracted from your words by the agent',
  agent: 'Proposed by the AI — not your claim unless you accept it',
};

export const KIND_LABELS: Record<ItemKind, string> = {
  original_idea: 'Original idea',
  factual_claim: 'Factual claim',
  causal_claim: 'Causal claim',
  hypothesis: 'Hypothesis',
  assumption: 'Assumption',
  analogy: 'Analogy',
  value_judgment: 'Value judgment',
  definition: 'Definition',
  question: 'Question',
  inference: 'Inference',
  uncertainty: 'Uncertainty',
  implication: 'Implication',
  extension: 'AI extension',
  objection: 'Objection',
  correction: 'Factual correction',
  evidence: 'Evidence',
  example: 'Example',
  test: 'Test',
  distinction: 'Distinction',
  conclusion: 'Conclusion',
  synthesis: 'Synthesis',
};

export const STATUS_LABELS: Record<ItemStatus, string> = {
  open: 'Open',
  needs_user: 'Needs you',
  accepted: 'Accepted',
  qualified: 'Accepted with qualification',
  rejected: 'Rejected',
  superseded: 'Superseded',
  merged: 'Merged',
  split: 'Split',
  tangent: 'Tangent',
};

/** "Accepted" is a statement about the reasoning state, never about truth. */
export const ACCEPTED_HINT = 'Accepted = accepted into your current reasoning, not proven true.';

export const STATUS_HINTS: Partial<Record<ItemStatus, string>> = {
  accepted: ACCEPTED_HINT,
  qualified: ACCEPTED_HINT,
  rejected: 'Rejected from your current reasoning. It stays in the record and can be reopened.',
  tangent: 'Set aside: interesting, but not part of this line of reasoning.',
  needs_user: 'The AI is asking for your judgement on this item.',
};

export const VERDICT_LABELS: Record<EpistemicVerdict, string> = {
  well_supported: 'Well supported',
  plausible_uncertain: 'Plausible, uncertain',
  disputed: 'Disputed',
  unsupported: 'Unsupported',
  misleading_framing: 'Misleading framing',
  probably_false: 'Probably false',
  false: 'False',
  normative: 'Normative',
  requires_clarification: 'Requires clarification',
};

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export const VERDICT_TONES: Record<EpistemicVerdict, Tone> = {
  well_supported: 'good',
  plausible_uncertain: 'warn',
  disputed: 'warn',
  unsupported: 'warn',
  misleading_framing: 'warn',
  probably_false: 'bad',
  false: 'bad',
  normative: 'neutral',
  requires_clarification: 'neutral',
};

export const ATTENTION_LABELS: Record<AttentionReason, string> = {
  clarification_needed: 'The AI needs you to clarify what you meant',
  unresolved_objection: 'An objection is waiting for your response',
  disputed_correction: 'A factual correction disputes this — your call',
  unresolved_assumption: 'An unstated assumption needs your confirmation',
  value_judgment_input: 'This is a value judgment only you can make',
  ambiguous_interpretation: 'Your words could be read more than one way',
  premise_needs_response: 'An AI-supplied premise is waiting for your response',
  decision_required: 'A decision is required before synthesis',
};

export const STAGE_LABELS: Record<IdeaStage, string> = {
  guided: 'Guided development',
  captured: 'Captured',
  in_review: 'In review',
  synthesized: 'Synthesised',
};

export const SOURCE_LABELS: Record<IdeaSource, string | null> = {
  captured: null,
  guided: 'Guided',
  promoted_tangent: 'From tangent',
};

export const PASS_LABELS: Record<Pass, string> = {
  extract: 'Step 2 · Extract',
  explore: 'Step 3 · Explore',
  epistemic: 'Step 4 · Fact-check',
  adversarial: 'Step 5 · Skeptic',
  builder: 'Step 6 · Builder',
  synthesize: 'Step 7 · Synthesis',
  discuss: 'Item discussion',
  tutor: 'Guided development',
};

export const AUTHOR_LABELS: Record<Author, string> = { user: 'You', agent: 'AI' };
export const ACTOR_LABELS: Record<Actor, string> = { user: 'You', agent: 'AI', system: 'System' };

export const DECISION_LABELS: Record<DecisionType, string> = {
  accept: 'Accepted',
  qualify: 'Accepted with qualification',
  reject: 'Rejected',
  reopen: 'Reopened',
  flag_needs_user: 'Flagged for your attention',
  mark_tangent: 'Set aside as tangent',
  split: 'Split into parts',
  merge: 'Merged',
  supersede: 'Replaced by a new formulation',
};

export const ADEQUACY_LABELS: Record<Adequacy, string> = {
  advances: 'Advances',
  partial: 'Partial',
  stuck: 'Stuck',
  off_track: 'Off track',
};

export const ADEQUACY_TONES: Record<Adequacy, Tone> = {
  advances: 'good',
  partial: 'warn',
  stuck: 'neutral',
  off_track: 'neutral',
};

export const STANCE_LABELS: Record<PremiseStance, string> = {
  accept: 'You accepted the premise',
  reject: 'You rejected the premise',
  modify: 'You changed the premise',
};

export const CONFIDENCE_TONES: Record<'tentative' | 'moderate' | 'firm', Tone> = {
  tentative: 'neutral',
  moderate: 'warn',
  firm: 'good',
};

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
