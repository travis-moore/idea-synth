/**
 * `npm run agent:check [-- --live]`
 *
 * Reports, without exposing any secret, whether the optional local subscription agent
 * (IDEA_SYNTH_PROVIDER=claude-cli) can run: is the official CLI installed, how does IT say
 * it is authenticated, and which billing-related environment variables would be withheld
 * from it. With --live it also sends ONE tiny structured request through the adapter.
 */
import { z } from 'zod';
import { ProviderError } from '../ai';
import { ClaudeCodeCliProvider } from '../ai/providers/claude-cli';
import { loadEnv } from '../config';

loadEnv();
const live = process.argv.includes('--live');
const provider = new ClaudeCodeCliProvider({
  bin: process.env.IDEA_SYNTH_CLAUDE_BIN,
  model: process.env.IDEA_SYNTH_MODEL,
  timeoutMs: 120_000,
});

try {
  const auth = await provider.checkAuth();
  console.log('Claude Code CLI login (as reported by `claude auth status`):');
  console.log(
    `  loggedIn=${auth.loggedIn} authMethod=${auth.authMethod} apiProvider=${auth.apiProvider} subscriptionType=${auth.subscriptionType ?? 'unknown'}`,
  );
  console.log(
    provider.withheldEnv.length
      ? `  Withheld from the agent so it cannot switch to API/cloud billing: ${provider.withheldEnv.join(', ')}`
      : '  No billing-redirecting environment variables are set.',
  );
  if (live) {
    const started = Date.now();
    const output = await provider.generate({
      pass: 'discuss',
      task: 'agent-check',
      promptVersion: 'agent-check',
      system: 'You are a connectivity check. Answer only with JSON matching the schema.',
      prompt: 'Reply with {"reply":"ok"}.',
      input: {},
      schema: z.object({ reply: z.string() }),
    });
    console.log(`Live request OK in ${Date.now() - started} ms: ${JSON.stringify(output)}`);
    console.log(`  provider info: ${JSON.stringify(provider.info())}`);
  } else
    console.log(
      'Run with --live to send one tiny real request (uses a little subscription allowance).',
    );
} catch (error) {
  if (error instanceof ProviderError) {
    console.error(`NOT AVAILABLE [${error.code}]: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
