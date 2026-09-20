import { serve } from '@hono/node-server';
import { createProvider } from '../ai';
import { dbPath, loadEnv, port } from '../config';
import { migrateToLatest, openDb } from '../db/client';
import { isEmpty, seedDemo } from '../seed/demo';
import { createApp } from './app';

loadEnv();

const db = openDb(dbPath());
const applied = await migrateToLatest(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

// First run: give the user something to explore straight away.
if (process.env.IDEA_SYNTH_SEED !== 'off' && (await isEmpty(db))) {
  await seedDemo(db);
  console.log('Seeded the demo idea (set IDEA_SYNTH_SEED=off to skip).');
}

const provider = createProvider();
const app = createApp({ db, provider }, { staticDir: './web/dist' });

serve({ fetch: app.fetch, port: port() }, (info) => {
  console.log(
    `Idea Synth API on http://localhost:${info.port}  (provider: ${provider.name}${provider.live ? '' : ', demo mode'})`,
  );
});
