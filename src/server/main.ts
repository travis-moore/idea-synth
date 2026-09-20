import { dirname, join, relative } from 'node:path';
import { serve } from '@hono/node-server';
import { createProvider } from '../ai';
import { dbPath, host, loadEnv, port, REPO_ROOT } from '../config';
import { migrateToLatest, openDb } from '../db/client';
import { isEmpty, seedDemo } from '../seed/demo';
import { JobRunner } from '../services/jobs';
import { createApp } from './app';
import { loadOrCreateToken, localSecurity } from './security';

loadEnv();

const db = openDb(dbPath());
const applied = await migrateToLatest(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

// First run: give the user something to explore straight away.
if (process.env.IDEA_SYNTH_SEED !== 'off' && (await isEmpty(db))) {
  await seedDemo(db);
  console.log('Seeded the demo idea (set IDEA_SYNTH_SEED=off to skip).');
}

const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host());
if (!loopback && process.env.IDEA_SYNTH_ALLOW_REMOTE !== '1') {
  console.error(
    `Refusing to listen on HOST=${host()}: Idea Synth has no user accounts, and anyone who can reach it could read and change your ideas and start agent jobs on your subscription. ` +
      'Use the default loopback address, or set IDEA_SYNTH_ALLOW_REMOTE=1 if you really mean it.',
  );
  process.exit(1);
}

const provider = createProvider();
const ctx = { db, provider };
const runner = new JobRunner(ctx, {
  concurrency: Number(process.env.IDEA_SYNTH_JOB_CONCURRENCY ?? 2),
});
const resumed = await runner.recover();
if (resumed) console.log(`Recovered ${resumed} job(s) interrupted by the last shutdown.`);
runner.start();

const tokenFile =
  dbPath() === ':memory:'
    ? join(REPO_ROOT, 'data', '.api-token')
    : join(dirname(dbPath()), '.api-token');
const security = {
  ...localSecurity(loadOrCreateToken(tokenFile), port()),
  allowRemotePeers: !loopback,
};
const app = createApp(ctx, {
  staticDir: relative(process.cwd(), join(REPO_ROOT, 'web/dist')) || '.',
  security,
  runner,
});

const server = serve({ fetch: app.fetch, port: port(), hostname: host() }, (info) => {
  console.log(`Idea Synth on http://${host()}:${info.port}  -  ${provider.status()}`);
  if (!loopback) console.warn('WARNING: listening beyond loopback with no user accounts.');
});

const shutdown = async () => {
  server.close();
  await runner.stop();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
