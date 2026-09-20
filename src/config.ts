import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load `.env` if present (Node's built-in loader; no dependency). Real env vars win. */
export function loadEnv(): void {
  const file = resolve(process.cwd(), '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export const dbPath = () => process.env.IDEA_SYNTH_DB ?? './data/idea-synth.sqlite';
export const port = () => Number(process.env.PORT ?? 8787);
