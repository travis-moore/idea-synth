# Idea Synth

**Develop an idea without outsourcing the thinking.**

> AI should scaffold reasoning rather than silently do the reasoning for the user.

Idea Synth takes an intuition written in your own words and helps you work out what is in
it: what you are actually claiming, what follows from it, what is factually shaky, what the
strongest objections are, which tangents are worth keeping — and then it **hands each of
those back to you** to discuss and decide on before anything is synthesised. The result is
a reasoned position whose whole history stays inspectable: which thoughts were yours, which
were the AI's, what changed and why.

A mistaken premise does not kill a good idea that grew out of it. _"Building pyramids
caused Egyptian progress"_ may not survive scrutiny, but _"can large collective projects
accelerate learning even when their product is useless?"_ can. Idea Synth keeps both, and
shows the link: **false premise, productive idea**.

Two rules drive the design:

- **Generate freely, evaluate explicitly, preserve provenance.**
- **Being wrong should be cheap, but believing something without examining it should be visible.**

## How it is meant to be used

1. You talk an idea through with **Claude Code or Codex in its VS Code panel**.
2. That agent does the reasoning itself and records it through the `synth` CLI, which
   validates everything ([docs/agent-workflow.md](docs/agent-workflow.md)). No API key, no
   second model.
3. The **web page is a live view**: the graph of linked reasoning nodes, each with its
   content, authorship, discussion, decisions, evidence and history. It updates as the
   agent writes, on a desktop or a phone.
4. Optionally, the same workflow can be driven from the web page by a local agent under
   your own Claude subscription ([docs/local-agent.md](docs/local-agent.md)), or by the
   clearly labelled demo mock.

## Quick start

```bash
npm install        # Node >= 20.19
npm run dev        # live view on http://127.0.0.1:5173 (viewer mode)
bin/synth help     # what a VS Code agent can do
npm run dev:demo   # or: try the whole workflow in the browser with labelled mock data
```

Then, in a Claude Code or Codex panel: _"Use Idea Synth (`~/idea-synth/bin/synth`, read
`docs/agent-workflow.md` first) to help me develop this idea: ..."_

No API key is needed for any of this. A fresh database is seeded with a demo idea (the
pyramids example) and a guided session ("robots mean nobody has to work"). See
[docs/development.md](docs/development.md) for a tour.

## What it does

**Idea Synthesis** — eight stages around a human review gate:

```
1 Capture (you) → 2 Extract → 3 Explore → 4 Fact-check → 5 Skeptic
      → YOUR REVIEW: discuss · accept · qualify · reject · split · branch · tangent
      → 6 Builder → 7 Synthesis → 8 Tangent archive
```

The Explorer always runs before the Skeptic, so criticism cannot kill a branch before it
has been captured. Details: [docs/workflow.md](docs/workflow.md).

**Guided Idea Development** — for a half-formed hypothesis. The agent asks rather than
answers, and raises its level of help (open question → narrower question → structure and
background → options → an explicitly AI-supplied premise you may accept, reject or change)
only when you are stuck. Details: [docs/guided-development.md](docs/guided-development.md).

**Views** — Inbox / Needs Attention · Open Questions · Tangent Library · Idea Map (graph)
· Item detail with discussion, provenance, evidence, revisions and full history · Synthesis
with every line traced to its sources.

## How it is built

A modular monolith in TypeScript: Hono API, SQLite through Kysely, React + React Flow,
Vitest. History tables are append-only and the captured idea and item authorship are
immutable **at the database level** (triggers). All AI output is schema-validated before
anything is written, whoever produced it: the VS Code agent through the CLI, a local
subscription worker, the API provider or the mock. Results computed from an idea that has
since changed are refused (input versions), and web-triggered work runs as durable jobs.

| Read                                                     | For                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)             | Layers, request lifecycle, configuration                                          |
| [docs/adr/0001-stack.md](docs/adr/0001-stack.md)         | Why this stack; the PostgreSQL path                                               |
| [docs/domain-model.md](docs/domain-model.md)             | Entities, authorship, relation types, provenance model                            |
| [docs/workflow.md](docs/workflow.md)                     | The eight stages, review gate, lifecycle diagram                                  |
| [docs/guided-development.md](docs/guided-development.md) | Adaptive scaffolding                                                              |
| [docs/ai-providers.md](docs/ai-providers.md)             | Provider abstraction, passes, validation, mock vs live                            |
| [docs/agent-workflow.md](docs/agent-workflow.md)         | **Using it from Claude Code / Codex**: rules, CLI, end-to-end examples            |
| [docs/local-agent.md](docs/local-agent.md)               | Optional web reasoning via your Claude subscription; durable jobs; local security |
| [docs/development.md](docs/development.md)               | Setup, commands, migrations, testing                                              |
| [docs/roadmap.md](docs/roadmap.md)                       | Known gaps and next steps                                                         |

## Working on this repository

```bash
npm run check      # format + lint + typecheck + tests
```

Coding agents (Claude Code, Codex, others): read [`.claude/CLAUDE.md`](.claude/CLAUDE.md)
first. It is the single source of instructions; `AGENTS.md` only points to it.

## Status

Early, single-user, local-first; the server binds to loopback and has no user accounts.
What has and has not been verified live is listed in [docs/roadmap.md](docs/roadmap.md).
The demo content illustrates the workflow; it does not assert historical facts.
