/**
 * The model/provider abstraction.
 *
 * The domain never imports a vendor SDK. A provider receives one fully described
 * request (system prompt, user prompt, structured input and the JSON schema it must
 * satisfy) and returns *unvalidated* data; validation is the caller's job so that
 * every provider, including the mock, goes through the same check.
 */
import type { z } from 'zod';
import type { Pass } from '../domain/vocabulary';

export interface StructuredRequest<T> {
  pass: Pass;
  /** Distinguishes multiple request shapes within one pass (e.g. tutor assess vs move). */
  task: string;
  promptVersion: string;
  system: string;
  prompt: string;
  /** The same information as `prompt`, as data. The mock provider works from this. */
  input: unknown;
  schema: z.ZodType<T>;
}

/** Honest, secret-free description of who produces output. Recorded on every run. */
export interface ProviderInfo {
  /** e.g. "mock", "anthropic", "claude-code-cli", or an external agent's name. */
  name: string;
  model: string;
  /**
   * How we know the model name: `provider` (we chose it), `cli_reported` (the CLI's own
   * result envelope said so), `self_reported` (an external agent merely claims it).
   */
  modelSource: 'provider' | 'cli_reported' | 'self_reported';
  /** e.g. "none", "api_key", "subscription:max", "external_session". Never a credential. */
  authMode: string;
}

export interface GenerateOptions {
  /** Aborting must stop the work (and kill any child process) promptly. */
  signal?: AbortSignal | undefined;
}

export interface ModelProvider {
  /** Short provider id, e.g. "mock" or "anthropic". */
  readonly name: string;
  readonly model: string;
  /** True if calls leave the machine. The UI shows a demo banner for the mock. */
  readonly live: boolean;
  /** False for the viewer-only provider: the web UI cannot trigger reasoning. */
  readonly canReason: boolean;
  info(): ProviderInfo;
  /** One honest, secret-free line about this provider for the UI. */
  status(): string;
  generate<T>(request: StructuredRequest<T>, options?: GenerateOptions): Promise<unknown>;
}

export type ProviderErrorCode =
  | 'not_configured'
  | 'not_logged_in'
  | 'wrong_auth_mode'
  | 'usage_limit'
  | 'invalid_output'
  | 'process_failed'
  | 'timeout'
  | 'cancelled'
  | 'refused'
  | 'api_error';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(message: string, options?: { cause?: unknown; code?: ProviderErrorCode }) {
    super(message, options);
    this.name = 'ProviderError';
    this.code = options?.code ?? 'api_error';
  }
}
