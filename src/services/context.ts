import type { ModelProvider } from '../ai';
import type { Db } from '../db/schema';

/** Everything a service needs. Built once in main.ts; built with a mock in tests. */
export interface AppContext {
  db: Db;
  provider: ModelProvider;
}
