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

| Variable              | Default                    | Meaning                                     |
| --------------------- | -------------------------- | ------------------------------------------- |
| `IDEA_SYNTH_PROVIDER` | `mock`                     | `mock` or `anthropic`                       |
| `ANTHROPIC_API_KEY`   | —                          | Needed only for `anthropic`                 |
| `IDEA_SYNTH_MODEL`    | `claude-opus-5`            | Model id for the live provider              |
| `IDEA_SYNTH_DB`       | `./data/idea-synth.sqlite` | SQLite file, or `:memory:`                  |
| `IDEA_SYNTH_SEED`     | on                         | Set `off` to skip seeding an empty database |
| `PORT`                | `8787`                     | API port                                    |

## What is deliberately absent

Authentication, multi-user support, background job queues, streaming, deployment
infrastructure, and web search for evidence. See [roadmap](roadmap.md).
