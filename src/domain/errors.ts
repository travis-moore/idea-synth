/** Errors the domain and services raise on purpose. The HTTP layer maps `code` to a status. */
export type DomainErrorCode = 'not_found' | 'invalid' | 'conflict' | 'forbidden' | 'upstream';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string, id: string) =>
  new DomainError('not_found', `${what} not found: ${id}`);
export const invalid = (message: string) => new DomainError('invalid', message);
export const conflict = (message: string) => new DomainError('conflict', message);
export const forbidden = (message: string) => new DomainError('forbidden', message);
/** A reasoning pass failed: the provider errored or its output did not validate. */
export const upstream = (message: string) => new DomainError('upstream', message);
