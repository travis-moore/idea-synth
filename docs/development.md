# Development guide

## Prerequisites

Node ≥ 20.19 (`.nvmrc` says 20) and npm. `better-sqlite3` ships prebuilt binaries for
common platforms; if it has to compile you will also need a C++ toolchain and Python.

## First run

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The API listens on :8787 and the Vite dev server proxies
`/api` to it. On first start the database (`data/idea-synth.sqlite`, git-ignored) is
created, migrated and seeded with the demo. No API key is required: the default provider
is the deterministic mock, and the UI shows a demo-mode banner.

A five-minute tour of the demo idea:

1. **Overview** — your words, preserved exactly, and the eight-step tracker.
2. **Review** — six items need you. Open _"Building the pyramids caused…"_: note the
   `probably false` verdict, the source quote highlighted in your text, the correction and
   evidence attached to it. Reject it, then see the **false premise · productive idea**
   badge and the surviving question it produced.
3. Discuss an objection ("Ask the AI"), qualify it, split the hypothesis, branch a tangent.
4. **Map** — the same structure as a graph; click any node for its full history.
5. **Overview → Build synthesis** — blocked until nothing needs you (or "Proceed anyway",
   which is recorded). Then **Synthesis**: every line has chips back to its sources.
6. **Tangents** — promote the video-games tangent to its own idea.
7. **Ideas → the robots hypothesis** — answer "I don't know" a few times and watch the
   scaffolding level rise to an AI-supplied premise you can accept, reject or change.

`npm run db:reset` puts the demo back to its starting state.

## Commands

| Command                           | Does                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`                     | API (tsx watch) + web (Vite) together                                      |
| `npm run check`                   | `format:check` + `lint` + `typecheck` + `test` — the gate for every commit |
| `npm test` / `npm run test:watch` | Vitest                                                                     |
| `npm run typecheck`               | `tsc --noEmit` for server and web                                          |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                          |
| `npm run db:migrate`              | Apply pending migrations                                                   |
| `npm run db:seed`                 | Add the demo idea and guided session                                       |
| `npm run db:reset`                | Delete the local DB, migrate, seed                                         |
| `npm run build` then `npm start`  | Build the client; serve API + client on :8787                              |

## Using a live model

```bash
cp .env.example .env
# IDEA_SYNTH_PROVIDER=anthropic
# ANTHROPIC_API_KEY=...
npm run dev
```

The seed always uses the mock, so seeding never spends credit. See
[ai-providers.md](ai-providers.md) for the caveat that the live provider is untested
against the real API.

## Migrations

Files in `src/db/migrations/`, registered in `migrations/index.ts`, applied automatically
at server start, by the DB CLI, and by `openTestDb()`.

1. Create `NNNN_description.ts` exporting `up(db)` and `down(db)`.
2. Register it in `migrations/index.ts`.
3. Mirror the change in `src/db/schema.ts`.
4. If you add a history table, add it to `APPEND_ONLY_TABLES` and create its triggers.
5. Never edit a committed migration; add a new one.

## Testing

Tests run against an in-memory SQLite database with the real migrations and triggers, and
the mock provider; the whole suite takes about a second.

| File                           | Covers                                                                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/provenance.test.ts`     | The ten product invariants (immutability, authorship, false-premise-productive-idea, split genealogy, rejection keeps history, tangent promotion, synthesis traceability, views, ordered attributable discussion) plus database-level guards |
| `tests/guided.test.ts`         | Scaffold level policy; user/agent attribution of guided steps and premises; hand-off                                                                                                                                                         |
| `tests/pipeline.test.ts`       | Pass order; invalid model output, unknown references, out-of-remit kinds, untraceable synthesis lines; resumability; arbitrary input                                                                                                         |
| `tests/rules.test.ts`          | Pure rules: decisions, genealogy cycles, productive descendants, review gate, id ordering                                                                                                                                                    |
| `tests/api.test.ts`            | Full workflow over HTTP; validation and error mapping                                                                                                                                                                                        |
| `tests/providers.test.ts`      | Provider selection, mock determinism, Anthropic provider with a faked SDK, schema conversion                                                                                                                                                 |
| `web/src/graph/layout.test.ts` | Graph layout direction                                                                                                                                                                                                                       |

To simulate a misbehaving model, wrap the mock (`TamperingProvider` in
`tests/pipeline.test.ts`).

## Troubleshooting

- _"A reasoning run is already in progress"_ — one pipeline run per idea at a time.
- _`append-only` / `immutable` SQLite errors_ — you tried to change history. Add a
  revision, decision, relation or new item instead.
- A hung request inside a transaction usually means code used `db` instead of the `trx`
  it was given (SQLite has a single connection).
