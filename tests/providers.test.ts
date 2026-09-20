import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { createProvider, MockProvider } from '../src/ai';
import { analysisRequests } from '../src/ai/passes';
import * as passSchemas from '../src/ai/schemas';
import { AnthropicProvider, type AnthropicMessagesClient } from '../src/ai/providers/anthropic';

const schema = z.object({ answer: z.string() });
const request = {
  pass: 'discuss' as const,
  task: 'discuss',
  promptVersion: 'test',
  system: 'system prompt',
  prompt: 'user prompt',
  input: {},
  schema,
};

function fakeClient(
  response: Record<string, unknown>,
  seen: unknown[] = [],
): AnthropicMessagesClient {
  return {
    messages: {
      create: (async (params: unknown) => {
        seen.push(params);
        return response;
      }) as unknown as AnthropicMessagesClient['messages']['create'],
    },
  };
}

describe('provider selection', () => {
  it('defaults to the mock so the app runs with no credentials', () => {
    expect(createProvider({})).toBeInstanceOf(MockProvider);
    expect(() => createProvider({ IDEA_SYNTH_PROVIDER: 'skynet' })).toThrow(/Unknown/);
  });
});

describe('mock provider', () => {
  it('is deterministic', async () => {
    const snapshot = {
      idea: {
        id: 'i',
        title: 't',
        originalTextOrigin: 'user' as const,
        originalText: 'Dogs bark because they are bored. Maybe cats are too?',
      },
      items: [],
      relations: [],
    };
    const mock = new MockProvider();
    const [a, b] = await Promise.all([
      mock.generate(analysisRequests.extract(snapshot)),
      mock.generate(analysisRequests.extract(snapshot)),
    ]);
    expect(a).toEqual(b);
  });
});

describe('anthropic provider (SDK faked; never calls the network in tests)', () => {
  it('sends the schema as a structured-output format and returns parsed JSON', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const provider = new AnthropicProvider({
      client: fakeClient(
        { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answer":"42"}' }] },
        seen,
      ),
    });
    expect(await provider.generate(request)).toEqual({ answer: '42' });
    expect(seen[0]).toMatchObject({ model: 'claude-opus-5', system: 'system prompt' });
    expect(seen[0]!.output_config).toMatchObject({ format: { type: 'json_schema' } });
  });

  it('turns refusals, truncation and non-JSON into provider errors', async () => {
    const make = (response: Record<string, unknown>) =>
      new AnthropicProvider({ client: fakeClient(response) });
    await expect(make({ stop_reason: 'refusal', content: [] }).generate(request)).rejects.toThrow(
      /declined/,
    );
    await expect(
      make({ stop_reason: 'max_tokens', content: [] }).generate(request),
    ).rejects.toThrow(/ran out/);
    await expect(
      make({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Sure! Here you go' }],
      }).generate(request),
    ).rejects.toThrow(/valid JSON/);
  });
});

describe('pass schemas', () => {
  it('all convert to the JSON-schema format the live provider sends', () => {
    const schemas = Object.entries(passSchemas).filter(([name]) => name.endsWith('OutputSchema'));
    expect(schemas.length).toBeGreaterThanOrEqual(9);
    for (const [name, schema] of schemas) {
      const format = zodOutputFormat(schema as z.ZodType);
      expect(format.type, name).toBe('json_schema');
      expect(JSON.stringify(format.schema).length, name).toBeGreaterThan(50);
    }
  });
});
