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
  /** "none" = viewer mode: the web UI can inspect and review, but cannot run reasoning. */
  provider: string;
  model: string;
  /** False for the mock: AI output is deterministic demo data. */
  live: boolean;
  /** True when web-triggered reasoning (analysis, synthesis, replies, tutoring) is available. */
  canReason: boolean;
  /** How the provider authenticates, e.g. "none", "api_key", "subscription:max". Never a secret. */
  authMode: string;
  /** Human-readable status of the provider (e.g. why a local agent is unavailable). */
  providerStatus: string;
  contractVersion: string;
}

/** Cheap change feed the UI polls: one number per idea, plus active jobs. */
export interface ChangesDto {
  ideas: Record<string, number>;
  activeJobs: number;
}

export type JobStatusDto =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** A unit of web-triggered agent work. Mutable status; not reasoning history. */
export interface JobDto {
  id: string;
  ideaId: string;
  kind: 'analyze' | 'synthesize' | 'discuss_reply' | 'guided_turn' | 'guided_handoff';
  status: JobStatusDto;
  progress: string | null;
  errorCode: string | null;
  error: string | null;
  attempts: number;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** For item- or session-scoped jobs. */
  itemId: string | null;
  sessionId: string | null;
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
  /** Input version: changes whenever the idea's reasoning state changes. */
  revision: number;
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
  /** When an agent relayed this decision: who, and the user's own words authorising it. */
  relayedBy: string | null;
  userInstruction: string | null;
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
  /** Which client performed the operation this event belongs to, if recorded. */
  operation: {
    client: string;
    executedBy: Actor;
    agentName: string | null;
    clientSession: string | null;
    userInstruction: string | null;
  } | null;
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
  /** `stale`: valid output that was not applied because the idea had changed meanwhile. */
  status: 'completed' | 'failed' | 'stale';
  error: string | null;
  startedAt: string;
  finishedAt: string;
  inputVersion: number | null;
  modelSource: string | null;
  authMode: string | null;
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
  respondsToStepId: string | null;
  createdAt: string;
}

export interface GuidedSessionDto {
  id: string;
  ideaId: string;
  hypothesis: string;
  status: 'active' | 'finished' | 'handed_off';
  level: number;
  inputVersion: number;
  /** What the session is waiting for. `assessment` and `move` are owed by a reasoner. */
  pendingTask: 'answer' | 'assessment' | 'move' | 'premise' | 'none';
  /** True when the user's answer is stored but has not been assessed yet (retry assessment). */
  awaitingAssessment: boolean;
  /** True while an agent-supplied premise is waiting for accept / reject / modify. */
  awaitingPremiseResponse: boolean;
  /** True when the tutor owes its next move (continue). */
  awaitingTutor: boolean;
  steps: GuidedStepDto[];
}

export interface ApiErrorDto {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
