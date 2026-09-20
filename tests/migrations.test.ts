import SqliteDatabase from 'better-sqlite3';
import { sql } from 'kysely';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateToLatest, openDb, openTestDb } from '../src/db/client';
import { APPEND_ONLY_TABLES } from '../src/db/schema';

describe('migrations', () => {
  it('protects every history table with append-only triggers', async () => {
    const db = await openTestDb();
    const triggers = await sql<{
      name: string;
    }>`select name from sqlite_master where type = 'trigger'`.execute(db);
    const names = new Set(triggers.rows.map((r) => r.name));
    for (const table of APPEND_ONLY_TABLES) {
      expect(names.has(`${table}_no_update`), table).toBe(true);
      expect(names.has(`${table}_no_delete`), table).toBe(true);
    }
  });

  it('upgrades a database created by the first release without touching its history', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'idea-synth-')), 'old.sqlite');
    // Build a v1 database: run only migration 0001, then add data as the first release did.
    const { Migrator } = await import('kysely');
    const { migrations } = await import('../src/db/migrations');
    const old = openDb(file);
    const only0001 = {
      getMigrations: async () => ({ '0001_initial': migrations['0001_initial']! }),
    };
    await new Migrator({ db: old, provider: only0001 }).migrateToLatest();
    await sql`insert into workspaces (id, name, created_at) values ('ws_default', 'w', 't')`.execute(
      old,
    );
    await sql`insert into ideas (id, workspace_id, title, original_text, source, stage, created_at, updated_at)
              values ('idea_old', 'ws_default', 't', 'My old thought.', 'captured', 'captured', 't', 't')`.execute(
      old,
    );
    await sql`insert into events (idea_id, type, actor, payload_json, created_at)
              values ('idea_old', 'idea.captured', 'user', '{}', 't')`.execute(old);
    await old.destroy();

    const db = openDb(file);
    expect(await migrateToLatest(db)).toEqual([
      '0002_clients_versions_jobs',
      '0003_request_fingerprints',
    ]);
    const idea = await db
      .selectFrom('ideas')
      .selectAll()
      .where('id', '=', 'idea_old')
      .executeTakeFirstOrThrow();
    expect(idea).toMatchObject({ original_text: 'My old thought.', revision: 0 });
    const event = await db.selectFrom('events').selectAll().executeTakeFirstOrThrow();
    expect(event).toMatchObject({ type: 'idea.captured', operation_id: null });
    await expect(db.updateTable('ideas').set({ original_text: 'x' }).execute()).rejects.toThrow(
      /immutable/,
    );
    await db.destroy();
    expect(new SqliteDatabase(file).pragma('journal_mode', { simple: true })).toBe('wal');
  });
});
