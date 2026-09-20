import { sql, type Kysely } from 'kysely';

/**
 * Multi-client support: VS Code agents (through the CLI), the web UI and local workers all
 * write to the same reasoning state.
 *
 * - `ideas.revision`   the idea's *input version*. Every change to reasoning state bumps
 *                      it; results computed from an older version are refused.
 * - `operations`       append-only envelope: who executed an operation, through which
 *                      client/session, on whose instruction, with which request id
 *                      (idempotency) and against which input version. Rejected and stale
 *                      attempts are recorded too.
 * - `jobs`             MUTABLE work queue for web-triggered agent work. Deliberately
 *                      separate from, and never a substitute for, the reasoning history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('ideas')
    .addColumn('revision', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();

  await db.schema
    .createTable('operations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('request_id', 'text', (c) => c.unique())
    .addColumn('idea_id', 'text', (c) => c.references('ideas.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('rejection_code', 'text')
    .addColumn('error', 'text')
    .addColumn('client', 'text', (c) => c.notNull())
    .addColumn('client_session', 'text')
    .addColumn('executed_by', 'text', (c) => c.notNull())
    .addColumn('agent_name', 'text')
    .addColumn('agent_model', 'text')
    .addColumn('contract_version', 'text')
    .addColumn('user_instruction', 'text')
    .addColumn('input_version', 'integer')
    .addColumn('result_json', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('operations_idea').on('operations').column('idea_id').execute();
  for (const action of ['UPDATE', 'DELETE'])
    await sql
      .raw(
        `CREATE TRIGGER operations_no_${action.toLowerCase()} BEFORE ${action} ON operations
         BEGIN SELECT RAISE(ABORT, 'append-only: operations rows cannot be changed'); END`,
      )
      .execute(db);

  // New columns on append-only tables. (ADD COLUMN is DDL; row triggers are unaffected
  // and existing rows simply read NULL.)
  await db.schema.alterTable('events').addColumn('operation_id', 'text').execute();
  await db.schema.alterTable('decisions').addColumn('relayed_by', 'text').execute();
  await db.schema.alterTable('decisions').addColumn('user_instruction', 'text').execute();
  await db.schema.alterTable('analysis_runs').addColumn('input_version', 'integer').execute();
  await db.schema.alterTable('analysis_runs').addColumn('operation_id', 'text').execute();
  await db.schema.alterTable('analysis_runs').addColumn('model_source', 'text').execute();
  await db.schema.alterTable('analysis_runs').addColumn('auth_mode', 'text').execute();
  await db.schema.alterTable('guided_steps').addColumn('responds_to_step_id', 'text').execute();

  await db.schema
    .createTable('jobs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('idea_id', 'text', (c) => c.notNull().references('ideas.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('payload_json', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('progress', 'text')
    .addColumn('error_code', 'text')
    .addColumn('error', 'text')
    .addColumn('request_id', 'text', (c) => c.unique())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('timeout_ms', 'integer', (c) => c.notNull())
    .addColumn('cancel_requested', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('worker_id', 'text')
    .addColumn('heartbeat_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('started_at', 'text')
    .addColumn('finished_at', 'text')
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('jobs_status').on('jobs').columns(['status', 'id']).execute();
  await db.schema.createIndex('jobs_idea').on('jobs').column('idea_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('jobs').ifExists().execute();
  await db.schema.dropTable('operations').ifExists().execute();
  // Added columns are left in place: SQLite cannot drop them from tables guarded by triggers
  // without rebuilding the table, and they are harmless when unused.
}
