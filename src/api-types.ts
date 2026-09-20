/**
 * The JSON shapes the HTTP API returns. Imported by both the server and the web client,
 * so a change here is a compile error on whichever side forgot to follow.
 * Types only: this file must not import runtime code.
 */
import type { ReviewGate } from './domain/rules';
import type { Adequacy, PremiseStance } from './domain/scaffolding';
import type {
  Actor,
  AttentionReason,
  Author,
  DecisionType,
  EpistemicVerdict,
  EventType,
  IdeaSource,
  IdeaStage,
  ItemKind,
  ItemStatus,
  Origin,
  Pass,
  RelationType,
} from './domain/vocabulary';

export interface MetaDto {
  provider: string;
  model: string;
  /** False in demo mode: AI output is deterministic mock data. */
  live: boolean;
}

export interface IdeaSummaryDto {
  id: string;
  title: string;
  originalText: string;
  source: IdeaSource;
  stage: IdeaStage;
  sourceItemId: string | null;
  sourceIdeaId: string | null;
  createdAt: string;
  counts: { items: number; needsUser: number; open: number; tangents: number };
  guidedSessionId: string | null;
}

export interface IdeaDto extends IdeaSummaryDto {
  rootItemId: string;
  gate: ReviewGate;
  /** Present for promoted tangents: where this idea came from. */
  promotedFrom: { ideaId: string; ideaTitle: string; itemId: string; itemText: string } | null;
  latestSynthesisVersion: number | null;
}

export interface ItemDto {
  id: string;
  ideaId: string;
  kind: ItemKind;
  origin: Origin;
  status: ItemStatus;
  text: string;
  epistemicVerdict: EpistemicVerdict | null;
  attentionReason: AttentionReason | null;
  /** Which reasoning pass created it, or null for user-created items. */
  createdByPass: Pass | null;
  createdAt: string;
  updatedAt: string;
  revisionCount: number;
  messageCount: number;
  /** "False premise, productive idea": ids of surviving ideas that arose from this failed premise. */
  productiveDescendantIds: string[];
  /** If this tangent was promoted, the idea it became. */
  promotedIdeaId: string | null;
}

/** An item in a cross-idea list view. */
export interface ItemWithIdeaDto extends ItemDto {
  ideaTitle: string;
}

export interface RelationDto {
  id: string;
  fromItemId: string;
  toItemId: string;
  type: RelationType;
  author: Author;
  note: string | null;
  createdAt: string;
}

export interface GraphDto {
  ideaId: string;
  nodes: ItemDto[];
  edges: RelationDto[];
}

export interface RevisionDto {
  id: string;
  seq: number;
  text: string;
  author: Author;
  reason: string | null;
  causedByItemId: string | null;
  createdAt: string;
}

export interface SourceSpanDto {
  id: string;
  quote: string;
  startOffset: number | null;
  endOffset: number | null;
}

export interface MessageDto {
  id: string;
  seq: number;
  author: Author;
  body: string;
  createdAt: string;
}

export interface DecisionDto {
  id: string;
  seq: number;
  type: DecisionType;
  author: Author;
  fromStatus: ItemStatus;
  toStatus: ItemStatus;
  rationale: string | null;
  qualification: string | null;
  relatedItemIds: string[];
  createdAt: string;
}

export interface AssessmentDto {
  id: string;
  verdict: EpistemicVerdict;
  rationale: string;
  author: Author;
  createdAt: string;
}

export interface EvidenceDto {
  item: ItemDto;
  stance: 'for' | 'against';
  sourceTitle: string;
  url: string | null;
  excerpt: string | null;
}

export interface EventDto {
  seq: number;
  type: EventType;
  actor: Actor;
  itemId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LinkedItemDto {
  relation: RelationDto;
  /** `out`: this item --type--> other. `in`: other --type--> this item. */
  direction: 'out' | 'in';
  item: ItemDto;
}

export interface ItemDetailDto {
  item: ItemDto;
  idea: { id: string; title: string; originalText: string };
  revisions: RevisionDto[];
  sources: SourceSpanDto[];
  messages: MessageDto[];
  decisions: DecisionDto[];
  assessments: AssessmentDto[];
  evidence: EvidenceDto[];
  links: LinkedItemDto[];
  events: EventDto[];
}

export interface RunDto {
  id: string;
  pass: Pass;
  provider: string;
  model: string;
  promptVersion: string;
  status: 'completed' | 'failed';
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface TracedLineDto {
  text: string;
  /** Ids of the reasoning items this line rests on. */
  refs: string[];
}

export interface SynthesisBodyDto {
  statement: string;
  initialThought: TracedLineDto;
  whatChanged: TracedLineDto[];
  rejected: TracedLineDto[];
  uncertain: TracedLineDto[];
  conclusions: Array<
    TracedLineDto & { itemId: string; confidence: 'tentative' | 'moderate' | 'firm' }
  >;
  evidence: TracedLineDto[];
  openQuestions: TracedLineDto[];
  archivedTangents: Array<{ itemId: string; reason: string }>;
}

export interface SynthesisDto {
  id: string;
  ideaId: string;
  itemId: string;
  version: number;
  runId: string;
  provider: string;
  model: string;
  createdAt: string;
  body: SynthesisBodyDto;
  /** Every item referenced anywhere in the body, so the UI can render provenance chips. */
  referencedItems: ItemDto[];
}

export interface GuidedStepDto {
  id: string;
  seq: number;
  author: Author;
  stepKind:
    | 'question'
    | 'answer'
    | 'feedback'
    | 'teaching'
    | 'options'
    | 'supplied_premise'
    | 'premise_response';
  level: number | null;
  body: string;
  options: string[] | null;
  adequacy: Adequacy | null;
  stance: PremiseStance | null;
  itemId: string | null;
  createdAt: string;
}

export interface GuidedSessionDto {
  id: string;
  ideaId: string;
  hypothesis: string;
  status: 'active' | 'finished' | 'handed_off';
  level: number;
  /** True while an agent-supplied premise is waiting for accept / reject / modify. */
  awaitingPremiseResponse: boolean;
  /** True when the last move failed to arrive and the session can be continued. */
  awaitingTutor: boolean;
  steps: GuidedStepDto[];
}

export interface ApiErrorDto {
  error: { code: string; message: string };
}
