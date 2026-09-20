/**
 * The operation envelope: who did this, through what, on whose say-so, against which
 * version of the idea, and have we seen this request before.
 *
 * Three different people-shaped facts must never be conflated:
 *   - AUTHOR    who wrote a piece of text          -> item `origin`, revision/message `author`
 *   - APPROVER  who made a judgement call          -> always the user (`decisions.author`)
 *   - EXECUTOR  who pressed the button             -> `operations.executed_by` (+ agent name)
 *
 * An agent in a VS Code panel may EXECUTE a user's decision, but only while carrying the
 * user's own instruction (`userInstruction`), which is stored. It can never be the
 * approver, and text it wrote stays agent-authored whoever approves it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Database, Db } from '../db/schema';
import { conflict, DomainError, forbidden, invalid } from '../domain/errors';
import { newId } from '../domain/ids';
import type { Actor } from '../domain/vocabulary';

/** Version of the JSON contracts the CLI / agent API speaks. Recorded on every operation. */
export const CONTRACT_VERSION = '2026-09-21.1';

export type ClientKind = 'web' | 'cli' | 'worker' | 'seed' | 'system';

export interface OperationMeta {
  /** Idempotency key. The same id always yields the same stored outcome. */
  requestId?: string | undefined;
  client: ClientKind;
  /** The client's own session identity, e.g. a Claude Code or Codex session id. */
  clientSession?: string | undefined;
  executedBy: Actor;
  /** e.g. "claude-code", "codex". Required when an agent executes. */
  agentName?: string | undefined;
  /** As reported by the agent. Stored as a claim, not as a verified fact. */
  agentModel?: string | undefined;
  /** The user's own words authorising a judgement call that an agent is relaying. */
  userInstruction?: string | undefined;
  /** The idea revision the caller based its work on. Refused if the idea has moved on. */
  inputVersion?: number | undefined;
}

export const WEB_USER: OperationMeta = { client: 'web', executedBy: 'user' };

interface ActiveOperation {
  id: string;
  meta: OperationMeta;
}
const storage = new AsyncLocalStorage<ActiveOperation>();

export const currentOperation = (): ActiveOperation | undefined => storage.getStore();

/**
 * Guard for judgement calls (accept, reject, split, merge, supersede, gate override...).
 * With no operation in scope the caller is the user acting directly (web UI, tests).
 */
export function requireUserAuthority(what: string): {
  relayedBy: string | null;
  userInstruction: string | null;
} {
  const op = currentOperation();
  if (!op || op.meta.executedBy === 'user') return { relayedBy: null, userInstruction: null };
  const instruction = op.meta.userInstruction?.trim();
  if (!instruction)
    throw forbidden(
      `Only the user can ${what}. To relay the user's decision, pass their own words as "userInstruction"; consent must never be inferred.`,
    );
  return {
    relayedBy: op.meta.agentName ?? op.meta.executedBy,
    userInstruction: op.meta.userInstruction!,
  };
}

export interface OperationOutcome<T> {
  operationId: string;
  result: T;
  /** True when this request id had already been applied and the stored result was returned. */
  replayed: boolean;
  /** The idea's input version after the operation. */
  inputVersion: number | null;
}

/** JSON with sorted keys, so the same request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const fingerprintOf = (name: string, ideaId: string | null, input: unknown): string =>
  createHash('sha256').update(canonical({ name, ideaId, input })).digest('hex');

export class StaleInputError extends DomainError {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    what = 'The idea',
  ) {
    super(
      'conflict',
      `${what} changed while this was being prepared (based on version ${expected}, now ${actual}). Nothing was applied. Re-read the context and try again.`,
      { reason: 'stale_input', expected, actual },
    );
  }
}

async function revisionOf(
  trx: Transaction<Database>,
  ideaId: string | null,
): Promise<number | null> {
  if (!ideaId) return null;
  const row = await trx
    .selectFrom('ideas')
    .select('revision')
    .where('id', '=', ideaId)
    .executeTakeFirst();
  return row ? Number(row.revision) : null;
}

/**
 * Run `fn` as one atomic, idempotent, version-checked operation.
 *
 * Order inside the single IMMEDIATE transaction: replay check -> input-version check ->
 * effects -> envelope row. Rejections (stale, invalid, forbidden) roll the effects back and
 * are then recorded on their own, so failed attempts are history too.
 */
export async function applyOperation<T>(
  db: Db,
  spec: {
    name: string;
    ideaId: string | null;
    meta: OperationMeta;
    /**
     * What is being asked, without `meta`. Required whenever a request id is given: a
     * reused id is only a retry if this matches what that id was first used for.
     */
    input?: unknown;
  },
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<OperationOutcome<T>> {
  const { name, meta } = spec;
  if (meta.executedBy === 'agent' && !meta.agentName?.trim())
    throw invalid('An agent must identify itself (agent name) on every operation.');
  if (meta.requestId && spec.input === undefined)
    throw invalid('Internal error: an operation with a request id must declare its input.');
  const fingerprint = meta.requestId ? fingerprintOf(name, spec.ideaId, spec.input) : null;
  const operationId = newId('op');
  const row = (ideaId: string | null) => ({
    id: operationId,
    request_id: meta.requestId ?? null,
    idea_id: ideaId,
    name,
    client: meta.client,
    client_session: meta.clientSession ?? null,
    executed_by: meta.executedBy,
    agent_name: meta.agentName ?? null,
    agent_model: meta.agentModel ?? null,
    contract_version: CONTRACT_VERSION,
    user_instruction: meta.userInstruction ?? null,
    input_version: meta.inputVersion ?? null,
    created_at: new Date().toISOString(),
    fingerprint,
  });

  try {
    return await db.transaction().execute(async (trx) => {
      if (meta.requestId) {
        const seen = await trx
          .selectFrom('operations')
          .selectAll()
          .where('request_id', '=', meta.requestId)
          .executeTakeFirst();
        if (seen) {
          if (seen.fingerprint && seen.fingerprint !== fingerprint)
            throw new DomainError(
              'conflict',
              `Request id "${meta.requestId}" was already used for a DIFFERENT request. Nothing was applied. Use a new request id; reuse one only to retry the identical request.`,
              { reason: 'request_id_reused' },
            );
          if (seen.name !== name)
            throw conflict(`Request id "${meta.requestId}" was already used for "${seen.name}".`);
          return {
            operationId: seen.id,
            result: JSON.parse(seen.result_json ?? 'null') as T,
            replayed: true,
            inputVersion: await revisionOf(trx, seen.idea_id),
          };
        }
      }
      if (meta.inputVersion !== undefined && spec.ideaId) {
        const actual = await revisionOf(trx, spec.ideaId);
        if (actual !== null && actual !== meta.inputVersion)
          throw new StaleInputError(meta.inputVersion, actual);
      }
      const result = await storage.run({ id: operationId, meta }, () => fn(trx));
      // `fn` may have created the idea this operation belongs to.
      const ideaId = spec.ideaId ?? (result as { ideaId?: string } | null)?.ideaId ?? null;
      await trx
        .insertInto('operations')
        .values({
          ...row(ideaId),
          status: 'applied',
          rejection_code: null,
          error: null,
          result_json: JSON.stringify(result ?? null),
        })
        .execute();
      return { operationId, result, replayed: false, inputVersion: await revisionOf(trx, ideaId) };
    });
  } catch (error) {
    if (error instanceof DomainError) {
      const code = (error.details as { reason?: string } | undefined)?.reason ?? error.code;
      await db
        .insertInto('operations')
        // Rejected attempts are history, but they do not reserve the request id: nothing was
        // applied, so the same request may be retried (a stale one must be rebuilt anyway).
        .values({
          ...row(spec.ideaId),
          request_id: null,
          status: 'rejected',
          rejection_code: code,
          error: `${meta.requestId ? `[request ${meta.requestId}] ` : ''}${error.message}`,
          result_json: null,
        })
        .execute()
        .catch(() => undefined);
    }
    throw error;
  }
}
