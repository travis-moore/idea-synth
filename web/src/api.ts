/**
 * Typed fetch client: one function per API route (see src/server/app.ts).
 * Every failure is thrown as an ApiError carrying the server's human-readable message.
 */
import type {
  ApiErrorDto,
  EventDto,
  GraphDto,
  GuidedSessionDto,
  IdeaDto,
  IdeaSummaryDto,
  ItemDetailDto,
  ItemWithIdeaDto,
  MetaDto,
  RunDto,
  SynthesisDto,
} from '../../src/api-types';
import type { PremiseStance } from '../../src/domain/scaffolding';
import type { DecisionType, ItemKind } from '../../src/domain/vocabulary';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function isApiErrorDto(value: unknown): value is ApiErrorDto {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Is the API running?');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (isApiErrorDto(payload)) {
      throw new ApiError(response.status, payload.error.code, payload.error.message);
    }
    throw new ApiError(response.status, 'unknown', `Request failed (${response.status}).`);
  }
  return payload as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);
const id = encodeURIComponent;

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

// --- Request bodies (mirror the zod schemas in src/server/app.ts) ------------------------

export interface ChildInput {
  text: string;
  kind?: ItemKind;
}
export interface DecisionInput {
  decision: DecisionType;
  rationale?: string;
  qualification?: string;
}
export interface BranchInput {
  text: string;
  kind?: ItemKind;
  asTangent?: boolean;
}
export interface MergeInput {
  itemIds: string[];
  text: string;
  kind?: ItemKind;
  rationale?: string;
}
export interface SupersedeInput {
  text: string;
  kind?: ItemKind;
  reason?: string;
  causedByItemId?: string;
}
export interface ReviseInput {
  text: string;
  reason?: string;
  causedByItemId?: string;
}
export interface EvidenceInput {
  text: string;
  stance: 'for' | 'against';
  sourceTitle: string;
  url?: string;
  excerpt?: string;
}

// --- Routes ---------------------------------------------------------------------------

export const api = {
  getMeta: () => get<MetaDto>('/meta'),

  listIdeas: () => get<IdeaSummaryDto[]>('/ideas'),
  captureIdea: (body: { text: string; title?: string }) => post<IdeaDto>('/ideas', body),
  getIdea: (ideaId: string) => get<IdeaDto>(`/ideas/${id(ideaId)}`),
  getGraph: (ideaId: string) => get<GraphDto>(`/ideas/${id(ideaId)}/graph`),
  listRuns: (ideaId: string) => get<RunDto[]>(`/ideas/${id(ideaId)}/runs`),
  listEvents: (ideaId: string) => get<EventDto[]>(`/ideas/${id(ideaId)}/events`),
  getSynthesis: (ideaId: string, version?: number) =>
    get<SynthesisDto | null>(withQuery(`/ideas/${id(ideaId)}/synthesis`, { version })),
  analyze: (ideaId: string) => post<IdeaDto>(`/ideas/${id(ideaId)}/analyze`),
  synthesize: (ideaId: string, force: boolean) =>
    post<SynthesisDto | null>(`/ideas/${id(ideaId)}/synthesize`, force ? { force: true } : {}),

  listInbox: (ideaId?: string) => get<ItemWithIdeaDto[]>(withQuery('/inbox', { ideaId })),
  listOpenQuestions: (ideaId?: string) =>
    get<ItemWithIdeaDto[]>(withQuery('/open-questions', { ideaId })),
  listTangents: (ideaId?: string) => get<ItemWithIdeaDto[]>(withQuery('/tangents', { ideaId })),

  getItem: (itemId: string) => get<ItemDetailDto>(`/items/${id(itemId)}`),
  mergeItems: (body: MergeInput) => post<ItemDetailDto>('/items/merge', body),
  postMessage: (itemId: string, body: { body: string; askAgent: boolean }) =>
    post<ItemDetailDto>(`/items/${id(itemId)}/messages`, body),
  decide: (itemId: string, body: DecisionInput) =>
    post<ItemDetailDto>(`/items/${id(itemId)}/decisions`, body),
  splitItem: (itemId: string, body: { children: ChildInput[]; rationale?: string }) =>
    post<ItemDetailDto>(`/items/${id(itemId)}/split`, body),
  branchItem: (itemId: string, body: BranchInput) =>
    post<ItemDetailDto>(`/items/${id(itemId)}/branch`, body),
  supersedeItem: (itemId: string, body: SupersedeInput) =>
    post<ItemDetailDto>(`/items/${id(itemId)}/supersede`, body),
  reviseItem: (itemId: string, body: ReviseInput) =>
    post<ItemDetailDto>(`/items/${id(itemId)}/revisions`, body),
  attachEvidence: (itemId: string, body: EvidenceInput) =>
    post<ItemDetailDto>(`/items/${id(itemId)}/evidence`, body),
  promoteTangent: (itemId: string, body: { framing?: string }) =>
    post<IdeaDto>(`/items/${id(itemId)}/promote`, body),

  startGuided: (hypothesis: string) => post<GuidedSessionDto>('/guided', { hypothesis }),
  getGuided: (sessionId: string) => get<GuidedSessionDto>(`/guided/${id(sessionId)}`),
  replyGuided: (sessionId: string, body: string) =>
    post<GuidedSessionDto>(`/guided/${id(sessionId)}/reply`, { body }),
  respondToPremise: (sessionId: string, body: { stance: PremiseStance; body?: string }) =>
    post<GuidedSessionDto>(`/guided/${id(sessionId)}/premise`, body),
  continueGuided: (sessionId: string) =>
    post<GuidedSessionDto>(`/guided/${id(sessionId)}/continue`),
  handOffGuided: (sessionId: string) => post<IdeaDto>(`/guided/${id(sessionId)}/handoff`),
};
