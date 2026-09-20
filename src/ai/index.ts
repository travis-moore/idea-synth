import { MockProvider } from './mock';
import type { ModelProvider } from './provider';
import { AnthropicProvider } from './providers/anthropic';

export type { ModelProvider, StructuredRequest } from './provider';
export { ProviderError } from './provider';
export { MockProvider } from './mock';

/**
 * Choose a provider from configuration. To add a vendor: implement `ModelProvider` in
 * `src/ai/providers/<name>.ts` and add a case here. Nothing else needs to change.
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const choice = (env.IDEA_SYNTH_PROVIDER ?? 'mock').toLowerCase();
  switch (choice) {
    case 'mock':
      return new MockProvider();
    case 'anthropic':
      return new AnthropicProvider({ model: env.IDEA_SYNTH_MODEL });
    default:
      throw new Error(`Unknown IDEA_SYNTH_PROVIDER "${choice}". Use "mock" or "anthropic".`);
  }
}
