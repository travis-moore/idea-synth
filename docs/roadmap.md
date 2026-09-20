# Roadmap

What exists today is a working vertical slice in demo mode. This file is the honest list
of what is missing and what to do next. Keep it current.

## Known gaps

**AI**

- The Anthropic provider has never been run against the live API. Prompts, schema
  constraints and token limits will need tuning on first contact.
- Passes run inside the HTTP request. With a live model, Steps 2–5 are four sequential
  model calls; that needs progress reporting (and probably a background job with polling
  or SSE) before it is pleasant to use.
- One provider serves every pass. Per-role routing (a cheaper model for extraction, a
  stronger one for the Skeptic) is designed for (`request.pass`, `ROLE_OF_PASS`) but not
  built.
- The epistemic pass cannot search. Evidence is either mock placeholder or attached by
  hand. A live evidence pass needs a search tool and real citations.
- In discussion the agent replies but cannot _propose_ structured actions (e.g. "split
  this into these three") for the user to apply with one click.

**Workflow**

- Analysis runs once per idea. Items the user adds during review (branches, split
  children) are not themselves explored / fact-checked / challenged. An incremental
  "analyse this item" pass is the natural next step.
- Relations cannot be added by hand in the UI ("this supports that").
- No retraction of a relation (edges are append-only; a `retracted_by` record would be
  needed, not deletion).
- Guided sessions end when the tutor's questions run out; there is no "ask me another" and
  no way to revisit an earlier question.

**Platform**

- Single user, no authentication, single process, SQLite only. The PostgreSQL path is
  described in ADR 0001 but untested.
- No export (Markdown / JSON with provenance) and no import.
- No end-to-end browser tests; UI behaviour is verified by hand and by a layout unit test.
- Ideas cannot be deleted or archived through the app.

## Next steps (suggested order)

1. **Make the live provider real.** Run each pass against Claude with the pyramids idea,
   tune prompts and schemas, add a recorded-fixture test per pass, then move pass execution
   to a background job with progress in the UI.
2. **Incremental analysis.** "Explore / check / challenge this item" on any item, so the
   review gate covers ideas the user adds mid-review. Reuse `executePass` and the existing
   schemas with a focused snapshot.
3. **Agent-proposed actions in discussion.** Let the `discuss` pass return typed proposals
   (split, reword, branch, tangent) that the UI shows as buttons. The user still decides;
   the decision row records that the proposal came from the agent.
4. **Evidence with real sources.** A search-backed epistemic pass that attaches cited
   evidence, plus a UI affordance for the user to judge source quality.
5. **Export and teaching material.** Export a synthesis with its provenance trail to
   Markdown; then use it for the NPO curriculum lesson on "using AI to develop an idea
   without letting it do your thinking for you" (see `.claude/CLAUDE.md` §11).

Smaller: a less sprawling map layout for wide ranks, code-splitting the web bundle
(React Flow makes it ~640 kB), manual relations, Playwright smoke test, archive/hide ideas, per-role
model routing.
