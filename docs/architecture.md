# Architecture

Idea Synth is a modular monolith: one Node process serving a JSON API and (in production
mode) the built web client, backed by one SQLite file. The reasons are in
[ADR 0001](adr/0001-stack.md).

## Layers

```mermaid
flowchart TD
  subgraph web["web/ — React client"]
    views["Views: Ideas · Inbox · Open Questions · Tangent Library<br/>Idea workspace: Overview · Review · Map · Synthesis · Tangents · History<br/>Item panel · Guided session"]
    layout["graph/layout.ts (pure dagre layout)"]
  end
  subgraph server["src/server — Hono"]
    app["app.ts: routes, zod request validation, error mapping"]
  end
  subgraph services["src/services — use cases"]
    pipeline["pipeline.ts<br/>Steps 2-5, review gate, Steps 6-8"]
    items["items.ts<br/>decide · split · branch · merge · supersede · revise · discuss · promote"]
    guided["guided.ts<br/>adaptive scaffolding sessions"]
    queries["queries.ts<br/>read side → DTOs, derived facts"]
    store["store.ts<br/>write primitives + audit events"]
  end
  subgraph ai["src/ai — model abstraction"]
    passes["passes.ts: prompts + request builders"]
    schemas["schemas.ts: zod output contracts"]
    providers["MockProvider · AnthropicProvider"]
  end
  domain["src/domain — pure vocabulary, rules, scaffolding policy"]
  db["src/db — Kysely, SQLite, migrations, provenance triggers"]

  views -->|"/api JSON (src/api-types.ts)"| app
  app --> pipeline & items & guided & queries
  pipeline & items & guided --> store
  pipeline & items & guided --> passes
  passes --> schemas
  pipeline --> providers
  store & queries --> db
  services --> domain
  ai --> domain
  web -. "types + pure values only" .-> domain
```

Rules of the road:

- `src/domain` has no I/O and imports none of the other layers (enforced by ESLint).
- `src/services/store.ts` is the only place that writes history tables.
- `src/ai/providers/anthropic.ts` is the only file that imports a vendor SDK.
- `src/server/app.ts` contains no reasoning rules.
- `web/` imports types from `src/api-types.ts` and pure constants from `src/domain/`.

## Request lifecycle: running the analysis

```mermaid
sequenceDiagram
  participant UI as Web client
  participant API as Hono app
  participant P as pipeline.ts
  participant M as ModelProvider
  participant DB as SQLite

  UI->>API: POST /api/ideas/:id/analyze
  API->>P: runAnalysis(ctx, ideaId)
  loop extract → explore → epistemic → adversarial
    P->>DB: buildSnapshot (items + relations so far)
    P->>M: generate(request: prompt, input, schema)
    M-->>P: unvalidated JSON
    P->>P: zod validation (schema), reference + kind checks
    alt valid
      P->>DB: ONE transaction: analysis_run + items + revisions + sources + relations + assessments + events
    else invalid or provider error
      P->>DB: failed analysis_run + run.failed event (nothing else)
      P-->>API: DomainError(upstream) → 502
    end
  end
  P->>DB: stage → in_review
  API-->>UI: IdeaDto (with review gate)
```

A failed pass leaves earlier passes in place and the idea still `captured`; calling analyse
again resumes from the first pass that has not completed.

## Runtime configuration

| Variable                                               | Default                    | Meaning                                                                                     |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- |
| `IDEA_SYNTH_PROVIDER`                                  | `none`                     | Web reasoning: `none` (viewer), `mock`, `claude-cli`, `anthropic`. No fallback between them |
| `IDEA_SYNTH_MODEL`                                     | provider default           | Model alias/id for `claude-cli` or `anthropic`                                              |
| `IDEA_SYNTH_CLAUDE_BIN`, `IDEA_SYNTH_AGENT_TIMEOUT_MS` | `claude`, 8 min            | `claude-cli` provider                                                                       |
| `ANTHROPIC_API_KEY`                                    | —                          | Only for `anthropic`; withheld from the `claude-cli` child                                  |
| `IDEA_SYNTH_DB`                                        | `./data/idea-synth.sqlite` | SQLite file shared by server, workers and CLI (relative to the repo root)                   |
| `IDEA_SYNTH_JOB_CONCURRENCY`                           | `2`                        | Parallel jobs (never more than one per idea)                                                |
| `IDEA_SYNTH_SEED`                                      | on                         | Set `off` to skip seeding an empty database                                                 |
| `HOST` / `PORT`                                        | `127.0.0.1` / `8787`       | Loopback by default; there are no user accounts                                             |

## Clients, and the one way reasoning gets in

```mermaid
flowchart LR
  subgraph reasoners["Who can produce a pass"]
    V["VS Code agent<br/>(reasons in its own conversation)"]
    P["configured provider<br/>mock · claude-cli · anthropic"]
  end
  V -->|"synth passes.next → JSON contract<br/>synth passes.submit"| C
  P -->|"job runner → executePass"| C
  C["commitPass<br/>1 zod validation<br/>2 BEGIN IMMEDIATE<br/>3 input version == read version ?<br/>4 still the legal next pass ? gate ?<br/>5 run row + apply + events"] --> DB[("SQLite")]
  C -. "too late → 'stale' run, not applied" .-> DB
```

- **Input versions.** `ideas.revision` is bumped by every state-changing event. A pass is
  prepared at a version and committed only if the idea is still there; the comparison and
  the writes share one `BEGIN IMMEDIATE` transaction, so it holds across processes (server,
  workers, CLI invocations) and against the user's own concurrent decisions. No transaction
  is ever open during a model call.
- **Operations.** Every client action runs through `applyOperation`, which records an
  append-only envelope (client, session, executor, agent, request id, input version, the
  user's instruction, outcome) and tags every event it causes. Request ids make retries
  idempotent; rejected and stale attempts are kept.
- **Jobs.** Reasoning requested from the browser is a row in the mutable `jobs` table,
  run by an in-process runner (bounded concurrency, one per idea, heartbeat, timeout,
  cancel, recovery after restart). See [local-agent.md](local-agent.md).
- **Live view.** The web client polls `GET /api/changes` (one revision number per idea
  plus the active job count) while visible and refetches only what moved.
- **Local security.** Loopback bind; Host, Origin and Sec-Fetch-Site checks; a per-install
  token on every non-GET; no CORS; no endpoint that takes a command or a path.

## What is deliberately absent

User accounts, multi-user support, streaming, deployment infrastructure, an MCP server
(the agent API is shaped for one), a Codex subscription adapter, and web search for evidence. See [roadmap](roadmap.md).
