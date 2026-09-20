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

export interface ModelProvider {
  /** Short provider id recorded on every run, e.g. "mock" or "anthropic". */
  readonly name: string;
  /** Model id recorded on every run. */
  readonly model: string;
  /** True if calls leave the machine. The UI shows a demo banner when false. */
  readonly live: boolean;
  generate<T>(request: StructuredRequest<T>): Promise<unknown>;
}

export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
  }
}
