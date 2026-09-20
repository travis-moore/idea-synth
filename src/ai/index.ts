import { MockProvider } from './mock';
import {
  ProviderError,
  type ModelProvider,
  type ProviderInfo,
  type StructuredRequest,
} from './provider';
import { AnthropicProvider } from './providers/anthropic';
import { ClaudeCodeCliProvider } from './providers/claude-cli';

export type { ModelProvider, StructuredRequest } from './provider';
export { ProviderError } from './provider';
export { MockProvider } from './mock';

/**
 * Viewer mode: no provider. The web UI shows the shared reasoning state and lets the user
 * review it; reasoning is done by an agent in a VS Code panel through the CLI.
 */
export class NoProvider implements ModelProvider {
  readonly name = 'none';
  readonly model = 'none';
  readonly live = false;
  readonly canReason = false;
  info(): ProviderInfo {
    return { name: this.name, model: this.model, modelSource: 'provider', authMode: 'none' };
  }
  status(): string {
    return 'viewer mode: no web reasoning provider configured';
  }
  generate<T>(_request: StructuredRequest<T>): Promise<unknown> {
    return Promise.reject(
      new ProviderError('No reasoning provider is configured for the web UI.', {
        code: 'not_configured',
      }),
    );
  }
}

export const PROVIDER_CHOICES = ['none', 'mock', 'claude-cli', 'anthropic'] as const;

/**
 * Choose a provider from configuration. There is NO automatic fallback between these:
 * in particular, a failing subscription CLI never silently becomes an API-billed call.
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const choice = (env.IDEA_SYNTH_PROVIDER ?? 'none').toLowerCase();
  switch (choice) {
    case 'none':
      return new NoProvider();
    case 'mock':
      return new MockProvider();
    case 'claude-cli':
      return new ClaudeCodeCliProvider({
        bin: env.IDEA_SYNTH_CLAUDE_BIN,
        model: env.IDEA_SYNTH_MODEL,
        timeoutMs: env.IDEA_SYNTH_AGENT_TIMEOUT_MS
          ? Number(env.IDEA_SYNTH_AGENT_TIMEOUT_MS)
          : undefined,
      });
    case 'anthropic':
      return new AnthropicProvider({ model: env.IDEA_SYNTH_MODEL });
    default:
      throw new Error(
        `Unknown IDEA_SYNTH_PROVIDER "${choice}". Use one of: ${PROVIDER_CHOICES.join(', ')}.`,
      );
  }
}
