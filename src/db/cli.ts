/** `npm run db:migrate | db:seed | db:reset` */
import { rmSync } from 'node:fs';
import { dbPath, loadEnv } from '../config';
import { seedDemo } from '../seed/demo';
import { migrateToLatest, openDb } from './client';

loadEnv();
const command = process.argv[2];
const path = dbPath();

async function main() {
  if (command === 'reset') {
    if (path === ':memory:') throw new Error('Nothing to reset for an in-memory database.');
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    console.log(`Removed ${path}`);
  } else if (command !== 'migrate' && command !== 'seed') {
    throw new Error('Usage: tsx src/db/cli.ts <migrate|seed|reset>');
  }
  const db = openDb(path);
  const applied = await migrateToLatest(db);
  console.log(
    applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Schema is up to date.',
  );
  if (command === 'seed' || command === 'reset') {
    const { ideaId } = await seedDemo(db);
    console.log(`Seeded demo idea ${ideaId}`);
  }
  await db.destroy();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
