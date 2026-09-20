import { sql, type Kysely } from 'kysely';

// Frozen copy of the tables this migration protects. It used to import the live list from
// ../schema, which meant adding a table there silently changed what this committed
// migration did. The SQL produced is identical; later migrations create their own triggers.
const APPEND_ONLY_TABLES = [
  'analysis_runs',
  'item_revisions',
  'item_sources',
  'relations',
  'discussion_messages',
  'decisions',
  'assessments',
  'evidence_details',
  'syntheses',
  'guided_steps',
  'events',
] as const;

/**
 * Initial schema.
 *
 * Tables are built with Kysely's schema builder so the same migration is close to
 * portable to PostgreSQL. The triggers at the bottom are SQLite syntax; a PostgreSQL
 * port needs equivalent `CREATE FUNCTION ... RAISE EXCEPTION` triggers.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('workspaces')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('ideas')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('original_text', 'text', (c) => c.notNull())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('stage', 'text', (c) => c.notNull())
    .addColumn('source_item_id', 'text')
    .addColumn('source_idea_id', 'text', (c) => c.references('ideas.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('analysis_runs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('idea_id', 'text', (c) => c.notNull().references('ideas.id'))
    .addColumn('pass', 'text', (c) => c.notNull())
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('model', 'text', (c) => c.notNull())
    .addColumn('prompt_version', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('input_json', 'text', (c) => c.notNull())
    .addColumn('output_json', 'text')
    .addColumn('error', 'text')
    .addColumn('started_at', 'text', (c) => c.notNull())
    .addColumn('finished_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('reasoning_items')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('idea_id', 'text', (c) => c.notNull().references('ideas.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('origin', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('text', 'text', (c) => c.notNull())
    .addColumn('epistemic_verdict', 'text')
    .addColumn('attention_reason', 'text')
    .addColumn('run_id', 'text', (c) => c.references('analysis_runs.id'))
    .addColumn('run_key', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('reasoning_items_idea_status')
    .on('reasoning_items')
    .columns(['idea_id', 'status'])
    .execute();

  await db.schema
    .createTable('item_revisions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('item_id', 'text', (c) => c.notNull().references('reasoning_items.id'))
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('text', 'text', (c) => c.notNull())
    .addColumn('author', 'text', (c) => c.notNull())
    .addColumn('reason', 'text')
    .addColumn('caused_by_item_id', 'text', (c) => c.references('reasoning_items.id'))
    .addColumn('run_id', 'text', (c) => c.references('analysis_runs.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('item_revisions_item_seq', ['item_id', 'seq'])
    .execute();

  await db.schema
    .createTable('item_sources')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('item_id', 'text', (c) => c.notNull().references('reasoning_items.id'))
    .addColumn('quote', 'text', (c) => c.notNull())
    .addColumn('start_offset', 'integer')
    .addColumn('end_offset', 'integer')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('item_sources_item').on('item_sources').column('item_id').execute();

  await db.schema
    .createTable('relations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('idea_id', 'text', (c) => c.notNull().references('ideas.id'))
    .addColumn('from_item_id', 'text', (c) => c.notNull().references('reasoning_items.id'))
    .addColumn('to_item_id', 'text', (c) => c.notNull().references('reasoning_items.id'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('author', 'text', (c) => c.notNull())
    .addColumn('note', 'text')
    .addColumn('run_id', 'text', (c) => c.references('analysis_runs.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('relations_unique_edge', ['from_item_id', 'to_item_id', 'type'])
    .execute();
  await db.schema.createIndex('relations_idea').on('relations').column('idea_id').execute();

  await db.schema
    .createTable('discussion_messages')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('item_id', 'text', (c) => c.notNull().references('reasoning_items.id'))
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('author', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('run_id', 'text', (c) => c.references('analysis_runs.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('discussion_messages_item_seq', ['item_id', 'seq'])
    .execute();

  await db.schema
    .createTable('decisions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('item_id', 'text', (c) => c.notNull().references('reasoning_items.id'))
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('author', 'text', (c) => c.notNull())
    .addColumn('from_status', 'text', (c) => c.notNull())
    .addColumn('to_status', 'text', (c) => c.notNull())
    .addColumn('rationale', 'text')
    .addColumn('qualification', 'text')
    .addColumn('related_item_ids', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('decisions_item_seq', ['item_id', 'seq'])
    .execute();

  await db.schema
    .createTable('assessments')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('item_id', 'text', (c) => c.notNull().references('reasoning_items.id'))
    .addColumn('verdict', 'text', (c) => c.notNull())
    .addColumn('rationale', 'text', (c) => c.notNull())
    .addColumn('author', 'text', (c) => c.notNull())
    .addColumn('run_id', 'text', (c) => c.references('analysis_runs.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('assessments_item').on('assessments').column('item_id').execute();

  await db.schema
    .createTable('evidence_details')
    .addColumn('item_id', 'text', (c) => c.primaryKey().references('reasoning_items.id'))
    .addColumn('source_title', 'text', (c) => c.notNull())
    .addColumn('url', 'text')
    .addColumn('excerpt', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('syntheses')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('idea_id', 'text', (c) => c.notNull().references('ideas.id'))
    .addColumn('item_id', 'text', (c) => c.notNull().references('reasoning_items.id'))
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('run_id', 'text', (c) => c.notNull().references('analysis_runs.id'))
    .addColumn('body_json', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('syntheses_idea_version', ['idea_id', 'version'])
    .execute();

  await db.schema
    .createTable('guided_sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('idea_id', 'text', (c) => c.notNull().unique().references('ideas.id'))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('level', 'integer', (c) => c.notNull())
    .addColumn('question_index', 'integer', (c) => c.notNull())
    .addColumn('current_question_item_id', 'text', (c) => c.references('reasoning_items.id'))
    .addColumn('pending_premise_item_id', 'text', (c) => c.references('reasoning_items.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('guided_steps')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('session_id', 'text', (c) => c.notNull().references('guided_sessions.id'))
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('author', 'text', (c) => c.notNull())
    .addColumn('step_kind', 'text', (c) => c.notNull())
    .addColumn('level', 'integer')
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('options_json', 'text')
    .addColumn('adequacy', 'text')
    .addColumn('stance', 'text')
    .addColumn('item_id', 'text', (c) => c.references('reasoning_items.id'))
    .addColumn('run_id', 'text', (c) => c.references('analysis_runs.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('guided_steps_session_seq', ['session_id', 'seq'])
    .execute();

  await db.schema
    .createTable('events')
    .addColumn('seq', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('idea_id', 'text', (c) => c.references('ideas.id'))
    .addColumn('item_id', 'text', (c) => c.references('reasoning_items.id'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('actor', 'text', (c) => c.notNull())
    .addColumn('payload_json', 'text', (c) => c.notNull())
    .addColumn('run_id', 'text', (c) => c.references('analysis_runs.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('events_item').on('events').column('item_id').execute();
  await db.schema.createIndex('events_idea').on('events').column('idea_id').execute();

  // --- Provenance guards (SQLite trigger syntax) -------------------------------------
  // History is append-only. These triggers make that a property of the database, not
  // just a convention in the service layer.
  for (const table of APPEND_ONLY_TABLES) {
    await sql
      .raw(
        `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
         BEGIN SELECT RAISE(ABORT, 'append-only: ${table} rows cannot be updated'); END`,
      )
      .execute(db);
    await sql
      .raw(
        `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
         BEGIN SELECT RAISE(ABORT, 'append-only: ${table} rows cannot be deleted'); END`,
      )
      .execute(db);
  }

  // The captured idea is permanent provenance.
  await sql
    .raw(
      `CREATE TRIGGER ideas_immutable_capture
       BEFORE UPDATE OF original_text, source, source_item_id, source_idea_id, created_at ON ideas
       BEGIN SELECT RAISE(ABORT, 'immutable: the captured idea cannot be changed'); END`,
    )
    .execute(db);
  await sql
    .raw(
      `CREATE TRIGGER ideas_no_delete BEFORE DELETE ON ideas
       BEGIN SELECT RAISE(ABORT, 'ideas cannot be deleted'); END`,
    )
    .execute(db);

  // Authorship and identity of an item never change; items are never deleted.
  await sql
    .raw(
      `CREATE TRIGGER reasoning_items_immutable_identity
       BEFORE UPDATE OF idea_id, kind, origin, run_id, run_key, created_at ON reasoning_items
       BEGIN SELECT RAISE(ABORT, 'immutable: item identity and origin cannot be changed'); END`,
    )
    .execute(db);
  await sql
    .raw(
      `CREATE TRIGGER reasoning_items_original_text_frozen
       BEFORE UPDATE OF text ON reasoning_items WHEN OLD.kind = 'original_idea'
       BEGIN SELECT RAISE(ABORT, 'immutable: the original idea cannot be reworded'); END`,
    )
    .execute(db);
  await sql
    .raw(
      `CREATE TRIGGER reasoning_items_no_delete BEFORE DELETE ON reasoning_items
       BEGIN SELECT RAISE(ABORT, 'reasoning items cannot be deleted'); END`,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tables = [
    'events',
    'guided_steps',
    'guided_sessions',
    'syntheses',
    'evidence_details',
    'assessments',
    'decisions',
    'discussion_messages',
    'relations',
    'item_sources',
    'item_revisions',
    'reasoning_items',
    'analysis_runs',
    'ideas',
    'workspaces',
  ];
  for (const table of tables) await db.schema.dropTable(table).ifExists().execute();
}
