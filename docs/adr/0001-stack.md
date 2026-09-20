# ADR 0001 — Stack and architecture

- Status: accepted
- Date: 2026-09-20

## Context

Idea Synth is a greenfield, single-user, local-first tool. Its hard requirements are
unusual: provenance and history are first-class, the reasoning structure is a graph, AI
output must be structured and validated, and almost everything must be testable without a
live model. It will be developed mostly by coding agents (Claude Code, Codex) from VSCode,
so the codebase must be easy to read end to end and cheap to verify.

The development machine has Node 20.20, npm 10, SQLite 3.45 and Python 3.12. No model API
keys are configured.

## Decision

**A modular monolith in one TypeScript package.**

| Concern     | Choice                                                                       | Why                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Language    | TypeScript (strict, ESM) end to end                                          | One language and one set of types from database row to React prop.                                                                   |
| Layout      | One `package.json`; `src/` (server side) and `web/` (client)                 | Workspaces and project references add ceremony without benefit at this size. `src/api-types.ts` is the shared contract.              |
| HTTP        | Hono on `@hono/node-server`                                                  | Tiny, typed, and `app.request()` lets integration tests run the real app with no socket.                                             |
| Persistence | SQLite via `better-sqlite3`                                                  | Zero-setup local relational store with real constraints, transactions and triggers.                                                  |
| Query layer | Kysely                                                                       | SQL-first and typed, fully async (including transactions), and dialect-portable. See "PostgreSQL path".                              |
| Migrations  | Kysely `Migrator`, statically imported TS modules                            | Run identically under tsx, Vitest and bundlers; applied automatically at start-up and in tests.                                      |
| Validation  | zod 4                                                                        | One schema library for HTTP bodies and model output; converts to JSON Schema for structured-output APIs.                             |
| AI          | `ModelProvider` interface; deterministic `MockProvider`; `AnthropicProvider` | Domain never sees a vendor SDK. Demo mode and tests need no key.                                                                     |
| Web         | Vite + React 19 + React Router + TanStack Query                              | Conventional, fast, well known to coding agents.                                                                                     |
| Graph       | React Flow (`@xyflow/react`) + dagre layout                                  | Maintained, React-native node rendering (badges, status, authorship on the node itself); layout is a pure function we can unit test. |
| Tests       | Vitest                                                                       | Fast; in-memory SQLite with the real migrations gives true integration tests in ~1 s.                                                |
| Quality     | ESLint flat config, Prettier, `tsc --noEmit`, GitHub Actions                 | `npm run check` is the single gate.                                                                                                  |

### Event-logged, not event-sourced

Current state lives in ordinary tables (`reasoning_items.status`, `.text`, ...) so queries
stay simple. Every change _also_ appends to history tables (`decisions`, `item_revisions`,
`assessments`, `discussion_messages`, `relations`, `events`) in the same transaction, and
the state columns are documented projections of those rows. Full event sourcing (state
rebuilt only from events) was rejected as unnecessary complexity for a single-user tool;
what matters is that history is complete and cannot be destroyed.

That last property is enforced **in the database**: triggers abort any UPDATE or DELETE on
history tables, freeze `ideas.original_text`, and freeze each item's `origin`, `kind` and
`idea_id`. A bug in a service, or an agent editing code carelessly, cannot silently rewrite
history; the statement fails.

### Node 20 pins

`better-sqlite3@13` and `vitest@5` require Node 22+. Rather than force a runtime upgrade on
day one, the project pins `better-sqlite3@12` and `vitest@4`, both of which support Node 20. Moving to Node 22/24 later is a version bump, not a redesign (and would allow the
built-in `node:sqlite` to be evaluated).

## PostgreSQL path

- All data access goes through Kysely with a typed `Database` interface; services are
  already async and transaction-scoped, so they do not depend on SQLite's synchronous
  driver.
- To move: swap `SqliteDialect` for `PostgresDialect` in `src/db/client.ts`; the table
  definitions in migrations use Kysely's schema builder and need only type touch-ups
  (`text` timestamps could become `timestamptz`, JSON text columns could become `jsonb`).
- The provenance triggers are written in SQLite syntax and must be re-expressed as
  PL/pgSQL trigger functions (`RAISE EXCEPTION`). This is the one non-mechanical step and
  is isolated at the bottom of `0001_initial.ts`.
- The per-idea pipeline lock is in-process (`pipeline.ts`). A multi-process deployment
  would replace it with a row lock or advisory lock.

## Consequences

- One process, one SQLite file: trivial to run, back up and reset. Not multi-user; there is
  no authentication. That is deliberate for this stage.
- Ideas and items cannot be deleted through the application. A future "delete my idea"
  feature must be a deliberate, explicit administrative path.
- The mock provider is a real, maintained part of the product (demo mode), not a test stub.
