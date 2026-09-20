import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, wherever the process was started from (the CLI runs from any cwd). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Load `.env` from the repo root if present (Node's built-in loader). Real env vars win. */
export function loadEnv(): void {
  const file = resolve(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

/** The SQLite file shared by the server, its workers and the CLI. */
export function dbPath(): string {
  const configured = process.env.IDEA_SYNTH_DB ?? './data/idea-synth.sqlite';
  return configured === ':memory:' || isAbsolute(configured)
    ? configured
    : resolve(REPO_ROOT, configured);
}

export const port = () => Number(process.env.PORT ?? 8787);
/** Loopback only, unless the user deliberately changes it. */
export const host = () => process.env.HOST ?? '127.0.0.1';
