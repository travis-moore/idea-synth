/**
 * `synth` - the local CLI through which an agent in a VS Code panel (Claude Code, Codex)
 * reads and contributes to Idea Synth. JSON in, JSON out, one command per invocation.
 *
 *   synth help                         list commands
 *   synth schema <command>             JSON Schema of a command's input
 *   synth <command> '<json>'           input as an argument
 *   synth <command> --input file.json  input from a file ("-" = stdin; best for user text)
 *
 * Convenience flags fill `meta` so JSON stays small:
 *   --agent NAME --session ID --model NAME --request-id ID --user-instruction "their words"
 *
 * Output is always one JSON document on stdout: {"ok":true,"data":...} or
 * {"ok":false,"error":{"code","message","details"}}. Exit code 0 / 1 (2 = usage).
 */
import { readFileSync } from 'node:fs';
import { describeCommands, runCommand, commands } from '../agent-api/commands';
import { dbPath, loadEnv } from '../config';
import { migrateToLatest, openDb } from '../db/client';
import { DomainError } from '../domain/errors';

const META_FLAGS: Record<string, string> = {
  '--agent': 'agent',
  '--session': 'sessionId',
  '--model': 'model',
  '--request-id': 'requestId',
  '--user-instruction': 'userInstruction',
};

function print(value: unknown, code: number): never {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]) {
  const [name, ...rest] = argv;
  const meta: Record<string, string> = {};
  let json: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const next = rest[i + 1];
    if (arg === '--input') {
      if (next === undefined)
        print({ ok: false, error: { code: 'usage', message: '--input needs a file or "-".' } }, 2);
      json = readFileSync(next === '-' ? 0 : next!, 'utf8');
      i++;
    } else if (arg in META_FLAGS) {
      if (next === undefined)
        print({ ok: false, error: { code: 'usage', message: `${arg} needs a value.` } }, 2);
      meta[META_FLAGS[arg]!] = next!;
      i++;
    } else if (json === undefined) json = arg;
    else print({ ok: false, error: { code: 'usage', message: `Unexpected argument: ${arg}` } }, 2);
  }
  return { name, json, meta };
}

async function main() {
  loadEnv();
  const { name, json, meta } = parseArgs(process.argv.slice(2));
  if (!name || name === 'help' || name === '--help')
    print(
      {
        ok: true,
        data: {
          usage:
            "synth <command> '<json>' | --input <file|-> [--agent NAME --session ID --model NAME --request-id ID --user-instruction TEXT]",
          guide: 'docs/agent-workflow.md',
          commands: describeCommands().map(({ name, description, mutating }) => ({
            name,
            mutating,
            description,
          })),
        },
      },
      0,
    );
  if (name === 'schema') {
    const entry = describeCommands().find((c) => c.name === json);
    if (!entry)
      print(
        {
          ok: false,
          error: {
            code: 'usage',
            message: `Unknown command. One of: ${Object.keys(commands).join(', ')}`,
          },
        },
        2,
      );
    print({ ok: true, data: entry }, 0);
  }

  let input: Record<string, unknown> = {};
  if (json !== undefined) {
    try {
      input = JSON.parse(json) as Record<string, unknown>;
    } catch {
      print(
        {
          ok: false,
          error: {
            code: 'invalid',
            message:
              'Input is not valid JSON. For text with quotes or newlines, use --input <file> or --input -.',
          },
        },
        1,
      );
    }
  }
  const envMeta = {
    ...(process.env.IDEA_SYNTH_AGENT ? { agent: process.env.IDEA_SYNTH_AGENT } : {}),
    ...(process.env.IDEA_SYNTH_AGENT_SESSION
      ? { sessionId: process.env.IDEA_SYNTH_AGENT_SESSION }
      : {}),
  };
  const mutating = (commands as Record<string, { mutating: boolean }>)[name!]?.mutating;
  if (mutating || Object.keys(meta).length > 0)
    input.meta = { ...envMeta, ...((input.meta as object | undefined) ?? {}), ...meta };

  const db = openDb(dbPath());
  try {
    await migrateToLatest(db);
    const data = await runCommand({ db }, name!, input);
    await db.destroy();
    print({ ok: true, data }, 0);
  } catch (error) {
    await db.destroy().catch(() => undefined);
    if (error instanceof DomainError)
      print(
        {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details ?? null },
        },
        1,
      );
    print(
      {
        ok: false,
        error: {
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      1,
    );
  }
}

void main();
