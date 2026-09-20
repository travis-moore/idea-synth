# Development guide

## Prerequisites

Node ≥ 20.19 (`.nvmrc` says 20) and npm. `better-sqlite3` ships prebuilt binaries for
common platforms; if it has to compile you will also need a C++ toolchain and Python.

## First run

```bash
npm install
npm run dev:demo     # web reasoning with the labelled mock, to tour the whole workflow
# or
npm run dev          # viewer mode (the default): reasoning comes from your VS Code agent
```

Open <http://127.0.0.1:5173> (it also works in a phone-sized window). The API listens on
127.0.0.1:8787 and the Vite dev server proxies `/api` to it. On first start the database
(`data/idea-synth.sqlite`, git-ignored) is created, migrated and seeded with the demo. No
API key is required in either mode.

A five-minute tour of the demo idea (`npm run dev:demo`):

1. The idea opens on its **Map**: every node shows who said it (you / from your words / AI)
   and where it stands. Click a node for its content, provenance, discussion and history.
2. **Review** — six items need you. Open _"Building the pyramids caused…"_: note the
   `probably false` verdict, the source quote highlighted in your text, the correction and
   evidence attached to it. Reject it, then see the **false premise · productive idea**
   badge and the surviving question it produced.
3. Discuss an objection ("Ask the AI" queues a job; your message is saved first), qualify
   it, split the hypothesis, branch a tangent.
4. **Build synthesis** — blocked until nothing needs you, or "Proceed anyway", which
   records an override for exactly the items shown. Then **Synthesis**: every line has
   chips back to its sources.
5. **Tangents** — promote the video-games tangent to its own idea.
6. **Ideas → the robots hypothesis** — answer "I don't know" a few times and watch the
   scaffolding level rise to an AI-supplied premise you can accept, reject or change.
7. Leave the page open and, in a terminal, add a node with `bin/synth items.branch ...`
   (see [agent-workflow.md](agent-workflow.md)): it appears without a reload.

`npm run db:reset` puts the demo back to its starting state.

## Commands

| Command                           | Does                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`                     | API (tsx watch) + web (Vite), viewer mode                                  |
| `npm run dev:demo`                | The same with `IDEA_SYNTH_PROVIDER=mock`                                   |
| `bin/synth help`                  | The agent CLI ([agent-workflow.md](agent-workflow.md))                     |
| `npm run agent:check [-- --live]` | Can the local subscription agent run? ([local-agent.md](local-agent.md))   |
| `npm run check`                   | `format:check` + `lint` + `typecheck` + `test` — the gate for every commit |
| `npm test` / `npm run test:watch` | Vitest                                                                     |
| `npm run typecheck`               | `tsc --noEmit` for server and web                                          |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                          |
| `npm run db:migrate`              | Apply pending migrations                                                   |
| `npm run db:seed`                 | Add the demo idea and guided session                                       |
| `npm run db:reset`                | Delete the local DB, migrate, seed                                         |
| `npm run build` then `npm start`  | Build the client; serve API + client on :8787                              |

## Web reasoning providers

Set `IDEA_SYNTH_PROVIDER` in `.env` (see `.env.example`): `none` (default), `mock`,
`claude-cli` ([local-agent.md](local-agent.md)) or `anthropic`. The seed always uses the
mock, so seeding never spends anything. There is no fallback between providers.

## Migrations

Files in `src/db/migrations/`, registered in `migrations/index.ts`, applied automatically
at server start, by the DB CLI, and by `openTestDb()`.

1. Create `NNNN_description.ts` exporting `up(db)` and `down(db)`.
2. Register it in `migrations/index.ts`.
3. Mirror the change in `src/db/schema.ts`.
4. If you add a history table, create its `_no_update` / `_no_delete` triggers in that
   migration and add it to `APPEND_ONLY_TABLES` (`tests/migrations.test.ts` checks the real
   database against that list).
5. Never edit a committed migration; add a new one. Existing databases must upgrade in
   place (`tests/migrations.test.ts` upgrades a first-release database).

## Testing

Tests run against an in-memory SQLite database with the real migrations and triggers. They
never call a model and never spawn a real CLI: fake providers and fake child processes only.

| File                                                                                                     | Covers                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/provenance.test.ts`                                                                               | The ten product invariants plus database-level guards                                                                                                                                                                    |
| `tests/correctness-gaps.test.ts`                                                                         | Guided answers stored before inference (exact text, failure, retry); decisions made while a model is running; override scope; agent authorship surviving approval                                                        |
| `tests/agent-api.test.ts`                                                                                | The CLI contract as an external agent uses it: a whole workflow with no provider, duplicate and stale submissions, unknown and cross-idea references, relayed decisions, gate and override, guided levels chosen by code |
| `tests/jobs.test.ts`                                                                                     | Worker timeout, cancellation, restart recovery, one job per idea, request-id idempotency                                                                                                                                 |
| `tests/claude-cli.test.ts`                                                                               | The subscription adapter with fake child processes: argument array, stdin, withheld billing env, auth verification, error codes, kill on timeout/cancel, schema sanitising                                               |
| `tests/api.test.ts`                                                                                      | HTTP workflow through jobs, viewer mode, change feed, host/origin/token protection                                                                                                                                       |
| `tests/guided.test.ts`, `tests/pipeline.test.ts`, `tests/review-findings.test.ts`, `tests/rules.test.ts` | Scaffolding, pass order and validation, earlier review findings, pure rules                                                                                                                                              |
| `tests/migrations.test.ts`                                                                               | Triggers on every history table; in-place upgrade of a first-release database                                                                                                                                            |
| `tests/providers.test.ts`                                                                                | Provider selection (viewer default), mock determinism, Anthropic provider with a faked SDK                                                                                                                               |
| `web/src/**/*.test.ts`                                                                                   | Pure UI logic (graph layout, live-refresh helpers)                                                                                                                                                                       |

To simulate a misbehaving model, extend `TestProvider` (`tests/helpers.ts`).

## Troubleshooting

- _"A reasoning run is already in progress"_ — one pipeline run per idea at a time.
- _`append-only` / `immutable` SQLite errors_ — you tried to change history. Add a
  revision, decision, relation or new item instead.
- _`stale_input` conflicts_ — the idea changed after the work was prepared. Re-read and redo.
- _401 from the API_ — non-GET requests need the `x-idea-synth-token` header
  (`GET /api/session`); _403_ — wrong `Host`/`Origin` (use 127.0.0.1 or localhost).
- A hung request inside a transaction usually means code used `db` instead of the `trx`
  it was given (SQLite has a single connection).
