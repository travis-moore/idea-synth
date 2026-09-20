import type { Kysely } from 'kysely';

/**
 * A request id only identifies a retry if the request is the same. `fingerprint` is a hash
 * of what was asked (operation, target, input); a reused id with a different fingerprint is
 * refused instead of being answered with somebody else's stored result.
 * Rows written before this migration have no fingerprint and replay as before.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('operations').addColumn('fingerprint', 'text').execute();
}

export async function down(): Promise<void> {
  // Additive column on an append-only table: left in place.
}
