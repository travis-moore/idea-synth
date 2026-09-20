# Idea Synth — instructions for coding agents

This is the **canonical** instruction file for every coding agent (Claude Code, Codex, or
anything else). `AGENTS.md` at the repo root only points here. Do not create a second set
of instructions anywhere; change this file instead.

## 1. What Idea Synth is

Idea Synth helps a person develop an idea **without replacing their thinking**.

> AI should scaffold reasoning rather than silently do the reasoning for the user.

The user captures an intuition in their own words. The system breaks it into reasoning
items, explores what follows from it, checks it, attacks it, and then **stops and hands
every significant item back to the user** for discussion and a decision. Only then does it
build the strongest defensible version, as a synthesis whose every line traces back to the
items and discussions it came from.

Two rules summarise the philosophy. They are product requirements, not slogans:

- **Generate freely, evaluate explicitly, preserve provenance.**
- **Being wrong should be cheap, but believing something without examining it should be visible.**

A mistaken premise must not destroy an interesting idea that arose from it. "Building
pyramids caused Egyptian progress" may be too strong, yet it produces a good question
("can large collective projects accelerate learning even when their product is useless?").
The system keeps both, and shows the relationship: **false premise, productive idea**.

### Non-negotiables (check every change against these)

1. **The captured idea is immutable.** Never rewrite, tidy, trim or "improve"
   `ideas.original_text` or the `original_idea` item. Database triggers enforce this.
2. **User vs agent authorship is permanent.** Every item has an `origin`
   (`user` | `extracted_from_user` | `agent`) that can never change. A user _accepting_ an
   AI item is a decision; it never makes the item "the user's idea". Never attribute
   AI-generated content to the user, in data or in UI wording.
3. **Never destructively collapse reasoning history.** No UPDATE or DELETE on history
   tables (see §7). Split, merge, supersede, reject and revise all _add_ rows and keep the
   originals. If you think you need to delete or overwrite, you need a new item, revision,
   decision or relation instead.
4. **The human review gate is real.** Steps 6–8 must not run past items that need the user
   unless the user explicitly overrides, and the override is recorded.
5. **Explorer before Skeptic.** Premature criticism kills branches before they are captured.
   Do not reorder the passes.
6. **The agent does not make the user's judgement calls.** It may flag an item for
   attention or set one aside as a tangent. Accept / qualify / reject / split / merge /
   supersede belong to the user (`statusAfterDecision` in `src/domain/rules.ts`).
7. **"Accepted" never means "true".** It means accepted into the current reasoning state.
   Keep UI copy and prompts consistent with that. Do not manufacture certainty.
8. **The graph is domain data,** stored in `reasoning_items` + `relations`. UI state is
   never the source of truth for structure or genealogy.
9. **It is not a chat app.** Conversation attaches to reasoning items. The graph and the
   structured items are primary.

## 2. Architecture overview

A modular monolith in one TypeScript package. No microservices, no cloud infrastructure.

```
web/ (React + React Flow)  ──HTTP /api──▶  src/server (Hono, thin)
                                              │
                                              ▼
                                       src/services  ──▶  src/ai (provider abstraction,
                                   (use cases, transactions)     prompts, schemas, mock)
                                              │
                                              ▼
                              src/domain (pure rules + vocabulary)
                                              │
                                              ▼
                                  src/db (Kysely + SQLite, migrations)
```

Dependency rule: `domain` imports nothing from the other layers (ESLint enforces this).
`services` may import `domain`, `db`, `ai`. `server` imports `services`. `web` imports only
**types** from `src/api-types.ts` and pure values from `src/domain/`.

Full details: `docs/architecture.md`, decision record `docs/adr/0001-stack.md`.

## 3. Repository structure

| Path               | What lives there                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/`      | Pure vocabulary (`vocabulary.ts`), rules (`rules.ts`), scaffolding policy (`scaffolding.ts`), ids, errors. No I/O.                                                                                                                          |
| `src/db/`          | Kysely table types (`schema.ts`), migrations (`migrations/`), client, CLI.                                                                                                                                                                  |
| `src/ai/`          | `provider.ts` (interface), `schemas.ts` (zod output contracts), `passes.ts` (prompts + request builders), `mock/` (deterministic provider), `providers/anthropic.ts` (live).                                                                |
| `src/services/`    | `store.ts` (write primitives, always log events), `pipeline.ts` (Steps 2–8), `items.ts` (review operations), `guided.ts`, `queries.ts` (read side → DTOs), `ideas.ts`.                                                                      |
| `src/server/`      | `app.ts` (routes + request validation), `main.ts` (entrypoint).                                                                                                                                                                             |
| `src/seed/`        | Demo data (pyramids idea, robots guided session).                                                                                                                                                                                           |
| `src/api-types.ts` | DTO contract shared by server and web. Types only.                                                                                                                                                                                          |
| `web/`             | Vite + React client: `api.ts` (typed client), `queries.ts` (react-query hooks), `labels.ts` (all UI wording for kinds/statuses/origins), `pages/`, `tabs/`, `item/` (item panel sections), `graph/` (`layout.ts` is the pure dagre layout). |
| `tests/`           | Vitest suites against in-memory SQLite with real migrations.                                                                                                                                                                                |
| `docs/`            | Architecture, domain model, workflow, guided development, AI providers, development guide, roadmap.                                                                                                                                         |
| `.devops.json`     | Pins the Azure DevOps project for the shared `devops` CLI (no secrets).                                                                                                                                                                     |

## 4. How to run

```bash
nvm use            # Node 20 (see .nvmrc); Node >= 20.19 required
npm install
npm run dev        # API on :8787, web on http://localhost:5173 (proxies /api)
```

First start migrates the database and seeds the demo idea. No API key is needed: the
default provider is the deterministic **mock** (`IDEA_SYNTH_PROVIDER=mock`). To use a live
model, copy `.env.example` to `.env`, set `IDEA_SYNTH_PROVIDER=anthropic` and provide
`ANTHROPIC_API_KEY`. Other commands:

```bash
npm run check        # format:check + lint + typecheck + test  (run before every commit)
npm test             # vitest
npm run db:reset     # delete local DB, migrate, re-seed the demo
npm run db:migrate   # apply pending migrations
npm run build && npm start   # production-style: API also serves web/dist on :8787
```

## 5. Coding conventions

- TypeScript strict, ESM, `verbatimModuleSyntax` (use `import type`). No `any`.
- Prettier (100 cols, single quotes) and ESLint flat config. Do not hand-format.
- Database columns are `snake_case`; DTOs are `camelCase`; mapping happens in `queries.ts`.
- Names come from `src/domain/vocabulary.ts`. Add new kinds, statuses, relation types or
  event types **there**, then update `docs/domain-model.md`. Never invent string literals
  for these elsewhere.
- All writes go through `src/services/store.ts` primitives so that every change emits an
  audit event in the same transaction. Do not write to history tables from anywhere else.
- Multi-step writes run inside `inTransaction` / `db.transaction()`. Inside a transaction
  use the `trx` you were given, never the outer `db` (SQLite has one connection: it will
  deadlock).
- HTTP handlers stay thin: validate with zod, call one service, return a DTO. Domain
  failures throw `DomainError`; `app.ts` maps codes to HTTP statuses.
- Comments explain _why_ (especially provenance reasons), not what.
- Derived facts (e.g. `productiveDescendantIds`, the review gate) are computed from stored
  history, never stored, so they cannot drift.

## 6. Testing expectations

- Test **domain behaviour**, not just rendering. New behaviour needs a test in `tests/`
  that runs against `openTestDb()` (in-memory SQLite, real migrations, real triggers).
- Tests never call a live model. Use `MockProvider`, or wrap it (see `TamperingProvider`
  in `tests/pipeline.test.ts`) to simulate bad model output.
- `tests/provenance.test.ts` encodes the ten product invariants. If a change breaks one,
  the change is wrong, not the test. Extend that file when you add a new way to transform
  reasoning state.
- Pure UI logic (e.g. graph layout) gets plain vitest tests under `web/src/**/*.test.ts`.

## 7. Provenance and history model (read before touching persistence)

State tables hold **projections**; history tables hold the **record**. Both are written in
the same transaction.

- Append-only (UPDATE and DELETE abort via triggers): `analysis_runs`, `item_revisions`,
  `item_sources`, `relations`, `discussion_messages`, `decisions`, `assessments`,
  `evidence_details`, `syntheses`, `guided_steps`, `events`.
- `reasoning_items`: only `status`, `text`, `epistemic_verdict`, `attention_reason`,
  `updated_at` may change, and only as projections of a new decision / revision /
  assessment row. `origin`, `kind`, `idea_id`, `run_id` are frozen. Rows are never deleted.
- `ideas`: `original_text`, `source`, `source_item_id`, `source_idea_id` are frozen.
- Every item records its producing `run_id`; every run records provider, model, prompt
  version, full input and validated output.
- Extracted items carry `item_sources` rows: verbatim quotes with offsets into the
  original text.

Questions the model must always be able to answer: where did this conclusion come from; was
it the user's thought or the AI's; which statement produced this tangent; which objection
caused this change; why was this rejected and what did the user say; which evidence was
considered; did one item split into three; what did this synthesis supersede. See
`docs/domain-model.md` for how each is answered.

## 8. Migrations

Migrations are TypeScript modules in `src/db/migrations/`, registered in
`migrations/index.ts` (static imports, so they work under tsx, Vitest and bundlers). They
run automatically at server start and in `openTestDb()`.

To change the schema: add `NNNN_description.ts` exporting `up`/`down`, register it, update
`src/db/schema.ts` to match, and add/adjust tests. **Never edit a migration that has been
committed.** New history tables must be added to `APPEND_ONLY_TABLES` so they get the
append-only triggers. Triggers are SQLite syntax; the PostgreSQL path is described in
`docs/adr/0001-stack.md`.

## 9. Model / provider abstraction

- The domain and services never import a vendor SDK. `src/ai/providers/anthropic.ts` is the
  only file that does.
- A pass = prompt + structured `input` + a zod output schema (`src/ai/schemas.ts`).
  `executePass` (in `pipeline.ts`) calls the provider, validates the output, and applies it
  in one transaction with its `analysis_runs` row. Invalid output, unknown references, or
  kinds / edge types outside the pass's remit (`ALLOWED_KINDS`, `ALLOWED_LINKS`) fail the
  whole pass and leave only a `failed` run. Models never write structural genealogy edges.
- `extracted_from_user` is only granted when the captured text is the user's and a quote
  is actually found in it (`src/domain/quotes.ts`); otherwise the item is the agent's.
- Passes/roles: `extract`, `explore` (Explorer), `epistemic` + `adversarial` (Skeptic),
  `builder` + `synthesize` (Builder), `discuss`, `tutor`.
- The **scaffolding level is chosen by code** (`nextScaffoldLevel`), not by the model.
- To add a provider: implement `ModelProvider`, add a case in `createProvider`
  (`src/ai/index.ts`). To run different passes on different models, route on
  `request.pass` inside a provider (not yet implemented; see `docs/roadmap.md`).
- When you change prompt wording, bump `PROMPT_VERSION` in `src/ai/passes.ts`.
- The mock must stay deterministic and must clearly label its output as mock/demo. Its
  pyramids fixture demonstrates the workflow; it does not assert history.
- Never commit API keys. `.env` is git-ignored; `.env.example` documents the variables.

## 10. Definition of done

A change is done when:

1. `npm run check` passes (format, lint, typecheck, tests).
2. New domain behaviour has tests; the ten provenance invariants still pass.
3. No history is destroyed and no authorship is blurred (see §1).
4. Schema changes have a new migration plus updated `schema.ts` and docs.
5. Docs are updated where behaviour, vocabulary or structure changed (`docs/`, this file).
6. For UI changes: you ran the app and exercised the change in a browser, in demo mode.
7. For non-trivial changes: you ran the adversarial review (§11) and fixed material findings.
8. Commits are focused, with a message that says why. No secrets, databases or build output.

## 11. Related repositories and tools

### shared-tools — `git@github.com:travis-moore/shared-tools.git`

Shared coding-agent tooling, normally cloned at `~/shared-tools`. **Reuse it; do not copy
it into this repo.** Read its `README.md` first; do not assume its layout.

- `devops/devops.py` — Azure DevOps CLI: work items, sprints, comments, and wiki pages
  (`wiki-get <page id>`, `wiki-put <path> --file`, `wiki-append`, `wiki-delete` which is
  dry-run by default). Run it as `python3 ~/shared-tools/devops/devops.py ...` (or `devops`
  if symlinked onto `PATH`). It finds its target from `.devops.json` in this repo and its
  token from `~/.config/devops-tools/.env`. It never prints the token; neither should you.
- `prompts/adversarial-review.md` — adversarial code-review prompt template with
  `{{TARGET_LABEL}}`, `{{USER_FOCUS}}`, `{{REVIEW_COLLECTION_GUIDANCE}}`, `{{REVIEW_INPUT}}`
  placeholders. There is no runner script: fill the placeholders and give it to a
  reviewing agent (a fresh subagent or a Codex session), with the diff or file set as
  `REVIEW_INPUT`. Ask for the JSON verdict it specifies, then fix material findings.
  For this repo, a good standing `USER_FOCUS` is: _provenance loss, authorship
  misattribution, history mutation, partial writes, and the review gate being bypassed._

If you build something genuinely generic (a reusable agent prompt, script or workflow), it
may belong in `shared-tools` rather than here: read that repo's conventions first, keep the
change in a separate commit in that repo, and never move Idea Synth application code there.

### NPO Robotics and AI curriculum (Azure DevOps wiki)

The user runs an NPO course whose curriculum lives in an Azure DevOps wiki:

`https://dev.azure.com/travis-private-org/robotics-and-ai-curriculum/_wiki/wikis/Robotics-and-AI-Curriculum.wiki/104/Home`

`.devops.json` in this repo pins that org/project/wiki, so from this directory
`python3 ~/shared-tools/devops/devops.py wiki-get 104` prints the curriculum home page.

If the user asks for something like _"make a lesson for the NPO course about using AI to
develop an idea without letting it do your thinking for you"_:

1. The concepts and workflows are in **this** repo: `docs/workflow.md` (eight stages,
   Explorer / Skeptic / Builder), `docs/guided-development.md` (adaptive scaffolding levels),
   and the philosophy in §1 above.
2. The curriculum is in the wiki above. **Read the relevant current pages first**
   (`wiki-get`), and match their structure, tone, languages (English and Japanese) and
   audience before drafting anything.
3. Use the shared-tools `devops` CLI for all reads and writes. Prefer `wiki-put` for
   living documents; `wiki-append` is only for logs that grow.
4. Do not modify the curriculum unless the user has asked for a curriculum change. Show the
   draft and the target page path before writing.

Never commit Azure DevOps credentials, PATs or any other secret.

## 12. Where to look next

`docs/roadmap.md` lists known gaps and the next sensible steps.
