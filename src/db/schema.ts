/**
 * Kysely table types. This mirrors the migrations in ./migrations; change both together.
 * Column names are snake_case here and camelCase in DTOs (see src/api-types.ts).
 */
import type { Generated, Kysely, Transaction } from 'kysely';
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
} from '../domain/vocabulary';
import type { Adequacy, PremiseStance } from '../domain/scaffolding';

export interface WorkspacesTable {
  id: string;
  name: string;
  created_at: string;
}

export interface IdeasTable {
  id: string;
  workspace_id: string;
  title: string;
  /** Immutable (trigger-enforced). The user's words, exactly as captured. */
  original_text: string;
  source: IdeaSource;
  stage: IdeaStage;
  /** For promoted tangents: the item (in another idea) this idea grew from. */
  source_item_id: string | null;
  source_idea_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisRunsTable {
  id: string;
  idea_id: string;
  pass: Pass;
  provider: string;
  model: string;
  prompt_version: string;
  status: 'completed' | 'failed';
  input_json: string;
  output_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string;
}

export interface ReasoningItemsTable {
  id: string;
  idea_id: string;
  kind: ItemKind;
  origin: Origin;
  /** Projection of the latest decision. */
  status: ItemStatus;
  /** Projection of the latest revision. */
  text: string;
  /** Projection of the latest assessment. */
  epistemic_verdict: EpistemicVerdict | null;
  attention_reason: AttentionReason | null;
  run_id: string | null;
  /** The local key the producing run used for this item. Debugging/provenance aid. */
  run_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemRevisionsTable {
  id: string;
  item_id: string;
  seq: number;
  text: string;
  author: Author;
  reason: string | null;
  /** The item (usually an objection or correction) that prompted this revision. */
  caused_by_item_id: string | null;
  run_id: string | null;
  created_at: string;
}

export interface ItemSourcesTable {
  id: string;
  item_id: string;
  /** Verbatim passage from the idea's original text. */
  quote: string;
  /** Offsets into ideas.original_text, or null when the quote could not be located. */
  start_offset: number | null;
  end_offset: number | null;
  created_at: string;
}

export interface RelationsTable {
  id: string;
  idea_id: string;
  from_item_id: string;
  to_item_id: string;
  type: RelationType;
  author: Author;
  note: string | null;
  run_id: string | null;
  created_at: string;
}

export interface DiscussionMessagesTable {
  id: string;
  item_id: string;
  seq: number;
  author: Author;
  body: string;
  run_id: string | null;
  created_at: string;
}

export interface DecisionsTable {
  id: string;
  item_id: string;
  seq: number;
  type: DecisionType;
  author: Author;
  from_status: ItemStatus;
  to_status: ItemStatus;
  rationale: string | null;
  qualification: string | null;
  /** JSON array of item ids produced by / involved in the decision (split children, merge target). */
  related_item_ids: string;
  created_at: string;
}

export interface AssessmentsTable {
  id: string;
  item_id: string;
  verdict: EpistemicVerdict;
  rationale: string;
  author: Author;
  run_id: string | null;
  created_at: string;
}

/** Citation details for items of kind `evidence`. */
export interface EvidenceDetailsTable {
  item_id: string;
  source_title: string;
  url: string | null;
  excerpt: string | null;
  created_at: string;
}

export interface SynthesesTable {
  id: string;
  idea_id: string;
  /** The `synthesis` reasoning item that represents this version in the graph. */
  item_id: string;
  version: number;
  run_id: string;
  body_json: string;
  created_at: string;
}

export interface GuidedSessionsTable {
  id: string;
  idea_id: string;
  status: 'active' | 'finished' | 'handed_off';
  level: number;
  question_index: number;
  current_question_item_id: string | null;
  /** Set while a level-5 agent-supplied premise awaits the user's response. */
  pending_premise_item_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GuidedStepsTable {
  id: string;
  session_id: string;
  seq: number;
  author: Author;
  step_kind:
    | 'question'
    | 'answer'
    | 'feedback'
    | 'teaching'
    | 'options'
    | 'supplied_premise'
    | 'premise_response';
  level: number | null;
  body: string;
  options_json: string | null;
  adequacy: Adequacy | null;
  stance: PremiseStance | null;
  /** The reasoning item this step created, if any. */
  item_id: string | null;
  run_id: string | null;
  created_at: string;
}

export interface EventsTable {
  seq: Generated<number>;
  idea_id: string | null;
  item_id: string | null;
  type: EventType;
  actor: Actor;
  payload_json: string;
  run_id: string | null;
  created_at: string;
}

export interface Database {
  workspaces: WorkspacesTable;
  ideas: IdeasTable;
  analysis_runs: AnalysisRunsTable;
  reasoning_items: ReasoningItemsTable;
  item_revisions: ItemRevisionsTable;
  item_sources: ItemSourcesTable;
  relations: RelationsTable;
  discussion_messages: DiscussionMessagesTable;
  decisions: DecisionsTable;
  assessments: AssessmentsTable;
  evidence_details: EvidenceDetailsTable;
  syntheses: SynthesesTable;
  guided_sessions: GuidedSessionsTable;
  guided_steps: GuidedStepsTable;
  events: EventsTable;
}

export type Db = Kysely<Database>;
/** Either the database or an open transaction. Service internals accept both. */
export type DbOrTrx = Kysely<Database> | Transaction<Database>;

/** Tables that may only ever be inserted into. Enforced by triggers in the migrations. */
export const APPEND_ONLY_TABLES = [
  'analysis_runs',
  'item_revisions',
  'item_sources',
  'relations',
  'discussion_messages',
  'decisions',
  'assessments',
  'evidence_details',
  'syntheses',
  'guided_steps',
  'events',
] as const;
