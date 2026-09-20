/**
 * Live provider backed by the Anthropic API.
 *
 * This is the ONLY file that imports the Anthropic SDK. It asks for structured output
 * constrained to the pass's schema, then hands the parsed JSON back unvalidated; the
 * caller (`executePass`) applies the same zod validation it applies to the mock.
 *
 * Credentials come from the environment (ANTHROPIC_API_KEY, or an `ant auth login`
 * profile). Nothing is read from, or written to, the repository.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ProviderError, type ModelProvider, type StructuredRequest } from '../provider';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

/** The slice of the SDK this provider uses. Tests inject a fake. */
export type AnthropicMessagesClient = { messages: Pick<Anthropic['messages'], 'create'> };

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly live = true;
  readonly model: string;
  private readonly client: AnthropicMessagesClient;

  constructor(options: { model?: string | undefined; client?: AnthropicMessagesClient } = {}) {
    this.model = options.model || DEFAULT_ANTHROPIC_MODEL;
    this.client = options.client ?? new Anthropic();
  }

  async generate<T>(request: StructuredRequest<T>): Promise<unknown> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        output_config: { format: zodOutputFormat(request.schema) },
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError)
        throw new ProviderError('Anthropic rejected the credentials. Check ANTHROPIC_API_KEY.', {
          cause: error,
        });
      if (error instanceof Anthropic.RateLimitError)
        throw new ProviderError('Anthropic rate limit reached. Try again shortly.', {
          cause: error,
        });
      if (error instanceof Anthropic.APIError)
        throw new ProviderError(`Anthropic API error ${error.status}: ${error.message}`, {
          cause: error,
        });
      throw new ProviderError('Could not reach the Anthropic API.', { cause: error });
    }

    if (response.stop_reason === 'refusal')
      throw new ProviderError(
        `The model declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`,
      );
    if (response.stop_reason === 'max_tokens')
      throw new ProviderError('The model ran out of output tokens before finishing its answer.');

    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ProviderError('The model did not return valid JSON.', { cause: error });
    }
  }
}
