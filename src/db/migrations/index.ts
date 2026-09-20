import type { Migration, MigrationProvider } from 'kysely';
import * as m0001 from './0001_initial';
import * as m0002 from './0002_clients_versions_jobs';
import * as m0003 from './0003_request_fingerprints';

/**
 * Migrations are imported statically (not scanned from disk) so they work identically
 * under tsx, Vitest and any future bundler. To add one: create `NNNN_name.ts` exporting
 * `up` and `down`, then register it here. Never edit a migration that has been committed.
 */
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_clients_versions_jobs': m0002,
  '0003_request_fingerprints': m0003,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: async () => migrations,
};
