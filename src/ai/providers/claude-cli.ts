/**
 * Local subscription-backed provider: runs the user's own, officially installed and
 * unmodified Claude Code CLI (`claude -p`) as a child process, under the login the user
 * already has there. Single-user and local by design.
 *
 * What this file deliberately does NOT do:
 *   - read, copy or forward subscription credentials, or talk to any HTTP API itself
 *   - implement a login flow (the user logs in with `claude auth login`, in a terminal)
 *   - fall back to API billing: credentials that would switch the CLI to API-key, gateway
 *     or cloud-provider billing are removed from the child's environment, user/project
 *     settings (which could carry an `apiKeyHelper`) are not loaded, and the CLI's own
 *     `auth status` must report a claude.ai login before any prompt is sent
 *   - give the model tools, files, MCP servers, slash commands, or a resumable session
 *   - build a shell command: a fixed executable, an argument array, the prompt on stdin
 *
 * Verified against Claude Code 2.1.x. See docs/local-agent.md for the documentation check.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ProviderError,
  type GenerateOptions,
  type ModelProvider,
  type ProviderInfo,
  type StructuredRequest,
} from '../provider';

/** Environment variables that would change WHO PAYS or WHERE the request goes. */
export const BILLING_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/** The slice of `child_process.spawn` this provider uses. Tests inject a fake. */
export interface ChildLike {
  stdin: {
    end(data?: string): void;
    on(event: 'error', listener: (e: Error) => void): unknown;
  } | null;
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; shell: false },
) => ChildLike;

const authStatusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
  subscriptionType: z.string().nullish(),
});
export type ClaudeAuthStatus = z.infer<typeof authStatusSchema>;

const envelopeSchema = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean(),
  result: z.string().nullish(),
  structured_output: z.unknown().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  permission_denials: z.array(z.unknown()).optional(),
});

export interface ClaudeCliOptions {
  /** Absolute path or command name of the official CLI. Never taken from a request. */
  bin?: string | undefined;
  /** Optional model alias/id passed to `--model`. Empty = the CLI's default. */
  model?: string | undefined;
  timeoutMs?: number | undefined;
  spawn?: SpawnLike | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * JSON Schema keywords the CLI's structured-output validator does not accept. With any of
 * them present it silently ignores the whole schema (observed on 2.1.x: the model then
 * answers in a shape of its own). They only tighten values, so dropping them is safe: the
 * full zod contract is applied to whatever comes back.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'format',
  'pattern',
  'default',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);

export function cliSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cliSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // `properties` maps property NAMES to schemas: a property may legitimately be called "default".
    if (key === 'properties' && value && typeof value === 'object')
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, cliSchema(sub)]),
      );
    else if (!UNSUPPORTED_KEYWORDS.has(key)) out[key] = cliSchema(value);
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class ClaudeCodeCliProvider implements ModelProvider {
  readonly name = 'claude-code-cli';
  readonly live = true;
  readonly canReason = true;
  private readonly bin: string;
  private readonly requestedModel: string | null;
  private readonly timeoutMs: number;
  private readonly spawn: SpawnLike;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private workDir: string | null = null;
  private reportedModel: string | null = null;
  private auth: { status: ClaudeAuthStatus; at: number } | null = null;
  /** Billing-related variables that were present and have been withheld from the child. */
  readonly withheldEnv: string[];

  constructor(options: ClaudeCliOptions = {}) {
    this.bin = options.bin?.trim() || 'claude';
    this.requestedModel = options.model?.trim() || null;
    this.timeoutMs = options.timeoutMs ?? 8 * 60_000;
    this.spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
    this.baseEnv = options.env ?? process.env;
    this.withheldEnv = BILLING_ENV_VARS.filter((name) => this.baseEnv[name] !== undefined);
  }

  get model(): string {
    return this.reportedModel ?? this.requestedModel ?? 'cli-default';
  }

  info(): ProviderInfo {
    const sub = this.auth?.status.subscriptionType;
    return {
      name: this.name,
      model: this.model,
      // Only a model name the CLI itself reported back counts as more than our request.
      modelSource: this.reportedModel ? 'cli_reported' : 'provider',
      authMode: this.auth ? `subscription:${sub ?? 'unknown'}` : 'unverified',
    };
  }

  status(): string {
    if (!this.auth) return 'local Claude Code CLI; login not checked yet';
    return `local Claude Code CLI, claude.ai login (${this.auth.status.subscriptionType ?? 'plan unknown'})`;
  }

  /** The child's environment: ours, minus anything that would redirect billing. */
  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...this.baseEnv };
    for (const name of BILLING_ENV_VARS) delete env[name];
    return env;
  }

  /** An empty directory, so the CLI finds no CLAUDE.md, settings, or project files. */
  private cwd(): string {
    this.workDir ??= mkdtempSync(join(tmpdir(), 'idea-synth-agent-'));
    return this.workDir;
  }

  private run(
    args: string[],
    stdin: string,
    signal?: AbortSignal,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(this.abortError(signal));
      let child: ChildLike;
      try {
        child = this.spawn(this.bin, args, {
          cwd: this.cwd(),
          env: this.childEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } catch (error) {
        return reject(
          new ProviderError(`Could not start "${this.bin}".`, {
            cause: error,
            code: 'process_failed',
          }),
        );
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const kill = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
        killTimer.unref?.();
      };
      const onAbort = () => {
        kill();
        finish(() => reject(this.abortError(signal!)));
      };
      const timer = setTimeout(() => {
        kill();
        finish(() =>
          reject(
            new ProviderError(
              `The local agent did not finish within ${Math.round(this.timeoutMs / 1000)}s and was stopped.`,
              { code: 'timeout' },
            ),
          ),
        );
      }, this.timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_OUTPUT_BYTES) {
          kill();
          finish(() =>
            reject(
              new ProviderError('The local agent produced too much output.', {
                code: 'invalid_output',
              }),
            ),
          );
        }
      });
      child.stderr?.on('data', (chunk) => (stderr += chunk.toString().slice(0, 20_000)));
      child.stdin?.on('error', () => undefined); // EPIPE if the child exits early; the close handler reports it
      child.on('error', (error) =>
        finish(() =>
          reject(
            new ProviderError(
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? `The Claude Code CLI ("${this.bin}") is not installed or not on PATH.`
                : `Could not run the Claude Code CLI: ${error.message}`,
              { cause: error, code: 'process_failed' },
            ),
          ),
        ),
      );
      child.on('close', (code) => {
        // Only now is the process really gone; until then the SIGKILL escalation stays armed.
        if (killTimer) clearTimeout(killTimer);
        finish(() => resolve({ code, stdout, stderr }));
      });
      child.stdin?.end(stdin);
    });
  }

  private abortError(signal: AbortSignal): ProviderError {
    const reason: unknown = signal.reason;
    return reason instanceof ProviderError
      ? reason
      : new ProviderError('Cancelled.', { code: 'cancelled' });
  }

  /**
   * Ask the CLI itself how it is authenticated, in the same environment the job will
   * use. We never infer "subscription" from the mere absence of an API key.
   */
  async checkAuth(signal?: AbortSignal): Promise<ClaudeAuthStatus> {
    if (this.auth && Date.now() - this.auth.at < 60_000) return this.auth.status;
    const { code, stdout, stderr } = await this.run(['auth', 'status', '--json'], '', signal);
    let status: ClaudeAuthStatus;
    try {
      status = authStatusSchema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new ProviderError(
        `Could not read the Claude Code login status (exit ${code}). ${stderr.trim().slice(0, 200)}`,
        { cause: error, code: 'process_failed' },
      );
    }
    if (!status.loggedIn)
      throw new ProviderError(
        'Claude Code is not logged in. Run "claude auth login" in a terminal, then try again.',
        {
          code: 'not_logged_in',
        },
      );
    if (
      status.authMethod !== 'claude.ai' ||
      (status.apiProvider && status.apiProvider !== 'firstParty')
    )
      throw new ProviderError(
        `Claude Code is authenticated via "${status.authMethod ?? 'unknown'}"/"${status.apiProvider ?? 'unknown'}", not a claude.ai subscription login. ` +
          'This provider refuses to run rather than bill an API key or a cloud account. Use IDEA_SYNTH_PROVIDER=anthropic if API billing is what you want.',
        { code: 'wrong_auth_mode' },
      );
    this.auth = { status, at: Date.now() };
    return status;
  }

  async generate<T>(
    request: StructuredRequest<T>,
    options: GenerateOptions = {},
  ): Promise<unknown> {
    await this.checkAuth(options.signal);
    const full = z.toJSONSchema(request.schema, { io: 'input' });
    const schema = JSON.stringify(cliSchema(full));
    // The schema also goes into the prompt: enforcement by the CLI is best-effort, and a
    // model that cannot see the contract cannot follow it.
    const prompt = `${request.prompt}\n\nOUTPUT CONTRACT: answer with ONE JSON object and nothing else. It must satisfy this JSON Schema exactly (use these property names; do not invent others):\n${JSON.stringify(full)}`;
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      schema,
      '--system-prompt',
      request.system,
      '--tools',
      '', // no built-in tools at all: nothing to read, write or execute
      '--strict-mcp-config', // and no MCP servers
      '--disable-slash-commands',
      '--setting-sources',
      '', // no user/project/local settings (hooks, apiKeyHelper, env)
      '--no-session-persistence', // nothing to resume; never --continue
      '--session-id',
      randomUUID(), // an explicit, fresh identity for this one job
      ...(this.requestedModel ? ['--model', this.requestedModel] : []),
    ];
    const { code, stdout, stderr } = await this.run(args, prompt, options.signal);

    const parsed = envelopeSchema.safeParse(safeJson(stdout));
    const envelope = parsed.success ? parsed.data : null;
    const text = `${envelope?.result ?? ''}\n${stderr}`.trim();
    if (!envelope || envelope.is_error || code !== 0) {
      if (/not logged in|\/login|authentication_failed|invalid api key/i.test(text)) {
        this.auth = null;
        throw new ProviderError(
          'Claude Code is not logged in. Run "claude auth login" in a terminal.',
          { code: 'not_logged_in' },
        );
      }
      if (
        /usage limit|session limit|weekly limit|rate.?limit|hit your .*limit|billing_error|credit balance/i.test(
          text,
        )
      )
        throw new ProviderError(
          `Your Claude subscription allowance is exhausted for now: ${text.slice(0, 300)}`,
          { code: 'usage_limit' },
        );
      throw new ProviderError(
        `The Claude Code CLI failed (exit ${code ?? 'killed'}${envelope?.subtype ? `, ${envelope.subtype}` : ''}): ${text.slice(0, 400) || 'no output'}`,
        { code: envelope ? 'api_error' : 'process_failed' },
      );
    }
    const reported = Object.keys(envelope.modelUsage ?? {});
    if (reported.length > 0) this.reportedModel = reported.join('+');
    // Still unvalidated either way: commitPass applies the shared contracts.
    if (envelope.structured_output !== undefined && envelope.structured_output !== null)
      return envelope.structured_output;
    const fromText = safeJson(
      (envelope.result ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''),
    );
    if (fromText === null)
      throw new ProviderError('The local agent returned no structured output.', {
        code: 'invalid_output',
      });
    return fromText;
  }
}
