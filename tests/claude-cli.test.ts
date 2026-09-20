/** The local subscription adapter, exercised with FAKE child processes only. */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderError } from '../src/ai';
import {
  ClaudeCodeCliProvider,
  cliSchema,
  type ChildLike,
  type SpawnLike,
} from '../src/ai/providers/claude-cli';
import { epistemicOutputSchema } from '../src/ai/schemas';

const request = {
  pass: 'discuss' as const,
  task: 'discuss',
  promptVersion: 'test',
  system: 'SYSTEM',
  prompt: 'User text with "quotes"; $(rm -rf /) && `backticks`\nand newlines',
  input: {},
  schema: z.object({ reply: z.string() }),
};

const SUBSCRIPTION = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
};
const ok = (structured: unknown) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: JSON.stringify(structured),
  structured_output: structured,
  modelUsage: { 'claude-test-model': {} },
});

interface Call {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  shell: boolean;
  stdin: string;
  killed: NodeJS.Signals[];
}

/** A scripted fake `spawn`. Each script entry answers one process launch. */
function fakeSpawn(
  script: Array<{
    stdout?: string;
    stderr?: string;
    code?: number;
    hang?: boolean;
    enoent?: boolean;
  }>,
) {
  const calls: Call[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    const step = script.shift() ?? { stdout: '', code: 0 };
    const child = new EventEmitter() as EventEmitter & ChildLike;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const call: Call = {
      command,
      args,
      env: options.env,
      cwd: options.cwd,
      shell: options.shell,
      stdin: '',
      killed: [],
    };
    calls.push(call);
    Object.assign(child, {
      stdout,
      stderr,
      stdin: {
        on: () => undefined,
        end: (data?: string) => {
          call.stdin = data ?? '';
          if (step.enoent)
            return child.emit(
              'error',
              Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
            );
          if (step.hang) return;
          setImmediate(() => {
            if (step.stdout) stdout.emit('data', Buffer.from(step.stdout));
            if (step.stderr) stderr.emit('data', Buffer.from(step.stderr));
            child.emit('close', step.code ?? 0, null);
          });
        },
      },
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        call.killed.push(signal);
        setImmediate(() => child.emit('close', null, signal));
        return true;
      },
    });
    return child;
  };
  return { spawn, calls };
}

const auth = (status: object) => ({ stdout: JSON.stringify(status) });
const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).code).toBe(code);
  return error as ProviderError;
};

describe('claude-code-cli provider (fake child processes)', () => {
  it('runs a fixed executable with an argument array, the prompt on stdin, no tools and no billing credentials', async () => {
    const { spawn, calls } = fakeSpawn([
      auth(SUBSCRIPTION),
      { stdout: JSON.stringify(ok({ reply: 'hi' })) },
    ]);
    const provider = new ClaudeCodeCliProvider({
      spawn,
      env: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        ANTHROPIC_API_KEY: 'sk-ant-SECRET',
        ANTHROPIC_BASE_URL: 'https://proxy',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
    });
    expect(await provider.generate(request)).toEqual({ reply: 'hi' });

    const [status, job] = calls;
    expect(status!.args).toEqual(['auth', 'status', '--json']);
    expect(job!.command).toBe('claude');
    expect(job!.shell).toBe(false);
    // User text never reaches the command line.
    expect(job!.stdin.startsWith(request.prompt)).toBe(true);
    expect(job!.stdin).toContain('OUTPUT CONTRACT');
    expect(job!.args.join(' ')).not.toContain('rm -rf');
    const flag = (name: string) => job!.args[job!.args.indexOf(name) + 1];
    expect(job!.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
      ]),
    );
    expect(flag('--tools')).toBe('');
    expect(flag('--setting-sources')).toBe('');
    expect(flag('--system-prompt')).toBe('SYSTEM');
    expect(flag('--session-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(flag('--json-schema')!)).toMatchObject({
      type: 'object',
      required: ['reply'],
    });
    for (const banned of [
      '--dangerously-skip-permissions',
      '--continue',
      '-c',
      '--resume',
      '--add-dir',
    ])
      expect(job!.args).not.toContain(banned);
    // Billing-redirecting variables are withheld from BOTH processes; the rest is kept.
    for (const call of calls) {
      expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(call.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(call.env.HOME).toBe('/home/u');
    }
    expect(provider.withheldEnv).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
    ]);
    expect(job!.cwd).toMatch(/idea-synth-agent-/);
    // Identity is reported without secrets, and the model is what the CLI said it used.
    expect(provider.info()).toEqual({
      name: 'claude-code-cli',
      model: 'claude-test-model',
      modelSource: 'cli_reported',
      authMode: 'subscription:max',
    });
    expect(JSON.stringify(provider.info())).not.toContain('SECRET');
  });

  it('does not claim subscription use: it refuses unless the CLI itself reports a claude.ai login', async () => {
    const loggedOut = fakeSpawn([auth({ loggedIn: false })]);
    const e1 = await expectCode(
      new ClaudeCodeCliProvider({ spawn: loggedOut.spawn, env: {} }).generate(request),
      'not_logged_in',
    );
    expect(e1.message).toMatch(/claude auth login/);
    expect(loggedOut.calls).toHaveLength(1); // no prompt was ever sent

    for (const status of [
      { loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' },
      { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' },
    ]) {
      const wrong = fakeSpawn([auth(status)]);
      const e2 = await expectCode(
        new ClaudeCodeCliProvider({ spawn: wrong.spawn, env: {} }).generate(request),
        'wrong_auth_mode',
      );
      expect(e2.message).toMatch(/refuses to run rather than bill/);
      expect(wrong.calls).toHaveLength(1);
    }
  });

  it('reports exhausted allowance, logout, bad output and process failure distinctly', async () => {
    const run = (step: object) =>
      new ClaudeCodeCliProvider({
        spawn: fakeSpawn([auth(SUBSCRIPTION), step]).spawn,
        env: {},
      }).generate(request);
    const err = (result: string) => ({
      stdout: JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result }),
      code: 1,
    });
    await expectCode(run(err("You've hit your session limit · resets 3pm")), 'usage_limit');
    await expectCode(run(err('Not logged in · Please run /login')), 'not_logged_in');
    await expectCode(run({ stdout: 'Segmentation fault', code: 139 }), 'process_failed');
    await expectCode(
      run({
        stdout: JSON.stringify({ type: 'result', is_error: false, result: 'Sure! Here you go' }),
      }),
      'invalid_output',
    );
    await expectCode(run({ enoent: true }), 'process_failed');
    const missing = fakeSpawn([{ enoent: true }]);
    const e = await expectCode(
      new ClaudeCodeCliProvider({ spawn: missing.spawn, env: {} }).generate(request),
      'process_failed',
    );
    expect(e.message).toMatch(/not installed/);
  });

  it('kills the child on timeout and on cancellation', async () => {
    const slow = fakeSpawn([auth(SUBSCRIPTION), { hang: true }]);
    await expectCode(
      new ClaudeCodeCliProvider({ spawn: slow.spawn, env: {}, timeoutMs: 20 }).generate(request),
      'timeout',
    );
    expect(slow.calls[1]!.killed).toContain('SIGTERM');

    const cancelled = fakeSpawn([auth(SUBSCRIPTION), { hang: true }]);
    const controller = new AbortController();
    const pending = new ClaudeCodeCliProvider({ spawn: cancelled.spawn, env: {} }).generate(
      request,
      { signal: controller.signal },
    );
    setTimeout(
      () => controller.abort(new ProviderError('Cancelled by the user.', { code: 'cancelled' })),
      10,
    );
    const e = await expectCode(pending, 'cancelled');
    expect(e.message).toMatch(/Cancelled by the user/);
    expect(cancelled.calls[1]!.killed).toContain('SIGTERM');
  });

  it('sends the CLI a schema without the keywords that make it ignore the schema', () => {
    const text = JSON.stringify(cliSchema(z.toJSONSchema(epistemicOutputSchema, { io: 'input' })));
    for (const keyword of [
      '"$schema"',
      '"format"',
      '"maxLength"',
      '"minLength"',
      '"default"',
      '"minItems"',
    ])
      expect(text).not.toContain(keyword);
    // Structure survives, including a property that happens to be called like a keyword.
    expect(text).toContain('"assessments"');
    expect(cliSchema({ properties: { default: { type: 'string', maxLength: 3 } } })).toEqual({
      properties: { default: { type: 'string' } },
    });
  });
});
