/**
 * Typed fetch client: one function per API route (see src/server/app.ts).
 * Every failure is thrown as an ApiError carrying the server's human-readable message.
 */
import type {
  ApiErrorDto,
  ChangesDto,
  EventDto,
  GraphDto,
  GuidedSessionDto,
  IdeaDto,
  IdeaSummaryDto,
  ItemDetailDto,
  ItemWithIdeaDto,
  JobDto,
  MetaDto,
  RunDto,
  SynthesisDto,
} from '../../src/api-types';
import type { PremiseStance } from '../../src/domain/scaffolding';
import type { DecisionType, ItemKind } from '../../src/domain/vocabulary';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Machine-readable extras, e.g. `blockingItemIds` when the review gate refuses. */
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** A string-array detail (e.g. `blockingItemIds`), or null when the server sent none. */
  detailIds(key: string): string[] | null {
    const value = this.details?.[key];
    return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
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

const TOKEN_HEADER = 'x-idea-synth-token';

/**
 * Every state-changing request carries a session token that only a same-origin page can
 * read (see src/server/security.ts). It is fetched once and kept in memory only.
 */
let tokenRequest: Promise<string> | null = null;

function sessionToken(): Promise<string> {
  tokenRequest ??= send<{ token: string }>('GET', '/session')
    .then((session) => session.token)
    .catch((error: unknown) => {
      tokenRequest = null;
      throw error;
    });
  return tokenRequest;
}

async function send<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  let response: Response;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token !== undefined) headers[TOKEN_HEADER] = token;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Is the API running?');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (isApiErrorDto(payload)) {
      const { code, message, details } = payload.error;
      throw new ApiError(response.status, code, message, details);
    }
    throw new ApiError(response.status, 'unknown', `Request failed (${response.status}).`);
  }
  return payload as T;
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (method === 'GET') return send<T>(method, path);
  try {
    return await send<T>(method, path, body, await sessionToken());
  } catch (error) {
    // The token changes if the server was reinstalled: fetch it again, once.
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    tokenRequest = null;
    return send<T>(method, path, body, await sessionToken());
  }
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
  getChanges: () => get<ChangesDto>('/changes'),

  /** Recent jobs for one idea, newest first (active and finished). */
  listJobs: (ideaId: string) => get<JobDto[]>(withQuery('/jobs', { ideaId })),
  listActiveJobs: (ideaId?: string) => get<JobDto[]>(withQuery('/jobs', { ideaId, active: 1 })),
  getJob: (jobId: string) => get<JobDto>(`/jobs/${id(jobId)}`),
  cancelJob: (jobId: string) => post<JobDto>(`/jobs/${id(jobId)}/cancel`),

  listIdeas: () => get<IdeaSummaryDto[]>('/ideas'),
  captureIdea: (body: { text: string; title?: string }) => post<IdeaDto>('/ideas', body),
  getIdea: (ideaId: string) => get<IdeaDto>(`/ideas/${id(ideaId)}`),
  getGraph: (ideaId: string) => get<GraphDto>(`/ideas/${id(ideaId)}/graph`),
  listRuns: (ideaId: string) => get<RunDto[]>(`/ideas/${id(ideaId)}/runs`),
  listEvents: (ideaId: string) => get<EventDto[]>(`/ideas/${id(ideaId)}/events`),
  getSynthesis: (ideaId: string, version?: number) =>
    get<SynthesisDto | null>(withQuery(`/ideas/${id(ideaId)}/synthesis`, { version })),
  /** Queues Steps 2-5. Answers at once with the job; the result arrives through the live view. */
  analyze: (ideaId: string) => post<JobDto>(`/ideas/${id(ideaId)}/analyze`),
  /**
   * Queues Steps 6-8. `overrideBlockingItemIds` must be exactly the blocking items the user
   * was shown when they chose to proceed anyway; the server refuses (409) otherwise.
   */
  synthesize: (ideaId: string, overrideBlockingItemIds?: string[]) =>
    post<JobDto>(
      `/ideas/${id(ideaId)}/synthesize`,
      overrideBlockingItemIds?.length ? { overrideBlockingItemIds } : {},
    ),

  listInbox: (ideaId?: string) => get<ItemWithIdeaDto[]>(withQuery('/inbox', { ideaId })),
  listOpenQuestions: (ideaId?: string) =>
    get<ItemWithIdeaDto[]>(withQuery('/open-questions', { ideaId })),
  listTangents: (ideaId?: string) => get<ItemWithIdeaDto[]>(withQuery('/tangents', { ideaId })),

  getItem: (itemId: string) => get<ItemDetailDto>(`/items/${id(itemId)}`),
  mergeItems: (body: MergeInput) => post<ItemDetailDto>('/items/merge', body),
  postMessage: (itemId: string, body: { body: string; askAgent: boolean }) =>
    post<{ detail: ItemDetailDto; job: JobDto | null }>(`/items/${id(itemId)}/messages`, body),
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
  retryGuidedAssessment: (sessionId: string) =>
    post<GuidedSessionDto>(`/guided/${id(sessionId)}/retry-assessment`),
  handOffGuided: (sessionId: string) => post<JobDto>(`/guided/${id(sessionId)}/handoff`),
};
