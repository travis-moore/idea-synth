# Optional: running reasoning from the web UI with a local subscription agent

By default the web UI is a **viewer** (`IDEA_SYNTH_PROVIDER` unset or `none`): it shows
and lets you review the shared state, while reasoning is done by your VS Code agent through
the CLI ([agent-workflow.md](agent-workflow.md)). Nothing here is needed for that.

If you also want the buttons in the web UI (Run analysis, Build synthesis, Ask the AI,
guided tutoring) to work, choose a provider **explicitly**:

| `IDEA_SYNTH_PROVIDER` | What runs                             | Who pays                           | Notes                                                       |
| --------------------- | ------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `none` (default)      | nothing                               | nobody                             | viewer mode                                                 |
| `mock`                | deterministic demo logic              | nobody                             | clearly labelled demo data (`npm run dev:demo`)             |
| `claude-cli`          | your installed `claude` CLI, headless | your Claude subscription allowance | this document                                               |
| `anthropic`           | Anthropic API via the SDK             | your API key                       | needs `ANTHROPIC_API_KEY`; unchanged from the first release |

There is **no fallback** between these. If `claude-cli` cannot run, jobs fail with a clear
reason; they never quietly become API-billed calls.

## What `claude-cli` does

It spawns the officially installed, unmodified Claude Code CLI as a child process for one
reasoning pass at a time (`src/ai/providers/claude-cli.ts`):

```
claude -p --output-format json --json-schema <pass schema> --system-prompt <pass instructions>
       --tools "" --strict-mcp-config --disable-slash-commands --setting-sources ""
       --no-session-persistence --session-id <fresh uuid> [--model <IDEA_SYNTH_MODEL>]
       (the prompt, including your idea's text, goes to stdin)
```

| Concern              | How it is handled                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command construction | Fixed executable (`claude`, or `IDEA_SYNTH_CLAUDE_BIN`), argument **array**, `shell: false`. User text only ever travels on stdin.                                                                               |
| Tools and files      | `--tools ""` removes every built-in tool; no MCP servers; no slash commands/skills; the working directory is a fresh empty temp dir. The model can read, write and execute nothing.                              |
| Permissions          | Nothing to permit, so **no** `--dangerously-skip-permissions` and no permission mode. (The trading-bot script this idea came from needs those because its agent edits a repository; this one only returns JSON.) |
| Session identity     | A fresh `--session-id` per job, `--no-session-persistence`, never `--continue`/`--resume`: no job can see another conversation, yours included.                                                                  |
| Settings             | `--setting-sources ""`: no user/project/local settings, so no hooks, no `env` block, no `apiKeyHelper`.                                                                                                          |
| Output               | The CLI's `structured_output` (or JSON text) is handed back **unvalidated** and goes through exactly the same contracts as any other reasoner (`commitPass`).                                                    |
| Timeouts / cancel    | Per-call timeout and job cancellation send SIGTERM, then SIGKILL after 3 s.                                                                                                                                      |

## Authentication: what is checked, and what is not claimed

Claude Code picks credentials in a documented order in which cloud-provider switches,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `apiKeyHelper` all outrank the
subscription login, and in `-p` mode an API key is always used when present
([authentication docs](https://code.claude.com/docs/en/authentication)). So "we did not
pass an API key" proves nothing. The adapter therefore:

1. **Withholds** from the child every variable that would change who pays or where the
   request goes: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` (and the
   Bedrock/Vertex/Foundry base URLs), `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
   `CLAUDE_CODE_USE_FOUNDRY`. Settings that could supply a key are not loaded (above).
2. **Asks the CLI itself**, in that same environment, before sending any prompt:
   `claude auth status --json` must report `loggedIn: true`, `authMethod: "claude.ai"` and
   a first-party `apiProvider`. Anything else → the job fails with `not_logged_in` or
   `wrong_auth_mode` and nothing is sent.
3. **Records only what it knows**: runs store `auth_mode = subscription:<plan>` (as reported
   by the CLI), and the model name the CLI's own result envelope reported
   (`model_source = cli_reported`). No credential, token, e-mail or organisation id is read,
   logged or stored by Idea Synth. `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), if
   you use it, is a subscription credential and is left alone.

Residual limits, stated plainly: the check is the CLI's own report, a minute-cached
snapshot; an admin-managed policy setting could still alter the CLI's behaviour; and the
`total_cost_usd` the CLI prints is its own estimate, not a bill, so Idea Synth ignores it.

`npm run agent:check` prints this status; `npm run agent:check -- --live` also sends one
tiny real request.

## Is this a supported use of a subscription?

Checked against the official documentation on 2026-09-21:

- The [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
  says OAuth authentication is for subscribers' "ordinary use of Claude Code and other
  native Anthropic applications", and that Anthropic does not permit **third-party
  developers** to offer claude.ai login or route requests through subscription credentials
  **on behalf of their users**; it adds that this does not prevent "an end user from
  signing in to the unmodified Claude Code binary with their own Claude subscription".
- [Headless mode](https://code.claude.com/docs/en/headless) (`claude -p`) is a documented
  feature of that binary.

This integration stays inside that: it is local and single-user, runs the unmodified
binary you installed and logged into yourself, implements no login flow, never touches the
credentials, and serves nobody but you. It must stay that way: do not turn it into a
hosted or multi-user service. What the documentation does **not** define is how much
scripted use counts as "ordinary"; usage limits apply to headless runs like any other, and
heavy automation is at your own judgement. Exhausted allowance surfaces as a failed job
with code `usage_limit` and the CLI's message.

**Codex.** The adapter boundary (`ModelProvider` + `ProviderInfo` + `ProviderError` codes)
is provider-neutral, and a `codex exec`-based adapter would slot into
`src/ai/providers/` beside this one. It is not implemented: the `codex` CLI is not
installed on the development machine, so nothing about its flags, auth reporting or terms
could be verified, and unverified claims do not belong in this file. Codex is fully
supported as a **VS Code agent through the `synth` CLI**, which needs no adapter at all.

## Failure reporting

| Code                    | Meaning                                         | Shown to the user as                                   |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `not_logged_in`         | CLI reports no login                            | "Run `claude auth login` in a terminal"                |
| `wrong_auth_mode`       | CLI is on an API key / gateway / cloud provider | refuses rather than bill it                            |
| `usage_limit`           | subscription allowance exhausted                | the CLI's own message, incl. reset time if given       |
| `invalid_output`        | no JSON came back                               | pass fails; nothing applied                            |
| (validation)            | JSON came back but broke a contract             | pass fails with the validation reason; nothing applied |
| `process_failed`        | CLI missing, crashed, or exited non-zero        | the exit code and stderr excerpt                       |
| `timeout` / `cancelled` | took too long / you cancelled the job           | child process killed                                   |

## Jobs

Web-triggered reasoning never runs inside an HTTP request. It becomes a row in the `jobs`
table (`queued → running → completed | failed | cancelled | interrupted`), executed by a
runner in the server process with bounded concurrency (`IDEA_SYNTH_JOB_CONCURRENCY`,
default 2) and at most one running job per idea. Your own input (a message, a guided
answer, a decision) is committed **before** the job is queued, so closing the browser loses
nothing. Jobs that were running when the server stopped are resumed on restart; every
handler is resumable and every result is applied through the input-version check, so a
resumed or duplicated job cannot apply the same reasoning twice or publish stale output.
`jobs` is mutable operational state and is kept apart from the append-only reasoning
history.

## Local-only service

The server binds to `127.0.0.1` and **refuses to start on any other `HOST`** unless
`IDEA_SYNTH_ALLOW_REMOTE=1` is set, because there are no user accounts. Headers can be
forged by non-browser clients, so the token endpoint and every state change additionally
require the TCP connection itself to come from loopback. Every request must carry a loopback `Host`; requests naming a foreign
`Origin` or `Sec-Fetch-Site` are refused; every state-changing or job-launching request
needs the per-installation token (`data/.api-token`, mode 600, served only to a same-origin
page via `GET /api/session`). No CORS headers are ever sent. There is no endpoint that
accepts a command, a path or an executable name: jobs are one of five fixed kinds.
