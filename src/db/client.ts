import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { Kysely, Migrator, SqliteDialect } from 'kysely';
import { migrationProvider } from './migrations';
import type { Database, Db } from './schema';

/** Open (creating if needed) a SQLite database. Pass ":memory:" for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new SqliteDatabase(path);
  sqlite.pragma('foreign_keys = ON');
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

export async function migrateToLatest(db: Db): Promise<string[]> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/** A migrated in-memory database. The standard fixture for tests. */
export async function openTestDb(): Promise<Db> {
  const db = openDb(':memory:');
  await migrateToLatest(db);
  return db;
}
