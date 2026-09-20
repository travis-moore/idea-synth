import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import {
  CompiledQuery,
  Kysely,
  Migrator,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type Driver,
  type SqliteDialectConfig,
} from 'kysely';
import { migrationProvider } from './migrations';
import type { Database, Db } from './schema';

/**
 * Every transaction in this application writes, and more than one process may have the
 * database open (the server, its workers, and `synth` CLI calls from VS Code agents).
 * A deferred BEGIN that reads first and writes later can fail half-way with
 * SQLITE_BUSY_SNAPSHOT, and makes check-then-write races possible. BEGIN IMMEDIATE takes
 * the write lock up front, so "check the input version, then apply" is atomic across
 * processes, and a busy database waits (busy_timeout) instead of erroring.
 */
class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin immediate'));
  }
}
class ImmediateSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;
  constructor(config: SqliteDialectConfig) {
    super(config);
    this.#config = config;
  }
  override createDriver(): Driver {
    return new ImmediateSqliteDriver(this.#config);
  }
}

/** Open (creating if needed) a SQLite database. Pass ":memory:" for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new SqliteDatabase(path);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
  return new Kysely<Database>({ dialect: new ImmediateSqliteDialect({ database: sqlite }) });
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
