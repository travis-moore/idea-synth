# Roadmap

This file is the honest list of what works, what has only been tested with fakes, and what
is missing. Keep it current.

## Verified, and how (2026-09-21)

| Capability                                                          | Verified live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Automated (fakes only)                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| VS Code agent → `synth` CLI → validated nodes in the graph          | **Yes.** A Claude Code session captured an idea, did the extract pass itself and submitted it; a retry with the same request id replayed; a submission at an old input version was refused and kept as a `stale` run                                                                                                                                                                                                                                                                                                                                                                                                             | `tests/agent-api.test.ts`                         |
| `claude-cli` subscription provider                                  | **Yes** (Claude Code 2.1.202, `authMethod: claude.ai`, plan `max`, no billing env vars present). `npm run agent:check -- --live`, then real explore, epistemic and adversarial passes through the durable job path on the CLI-captured idea, ending `in_review` with the gate closed. Along the way real model output was refused twice (a shape the CLI had not enforced; an item kind outside the pass's remit): nothing was applied, the job failed with the reason, and re-queuing resumed at the failed pass. Both causes were then fixed (schema sanitising + contract in the prompt; remit stated in every pass contract) | `tests/claude-cli.test.ts` (fake child processes) |
| Local request protection (loopback bind; host, origin, token)       | **Yes**, with `curl` against a real socket: 401 without token, 403 for a foreign origin, 403 for a foreign host                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `tests/api.test.ts`                               |
| Jobs: timeout, cancellation, restart recovery                       | No (resume after a _failed_ pass was seen live; kill/timeout/crash only with fakes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/jobs.test.ts`                              |
| Exhausted subscription allowance; logged-out CLI; API-key auth mode | No (not reproducible on demand)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | fake child processes                              |
| Builder and synthesis passes with a live model                      | No                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | mock provider                                     |
| `anthropic` API provider                                            | **Never run live** (no API key available)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | faked SDK client                                  |
| Codex                                                               | The `synth` CLI contract is agent-neutral, but **no Codex session has exercised it**, and there is no Codex subscription adapter: the `codex` CLI is not installed on the development machine, so nothing about it could be verified                                                                                                                                                                                                                                                                                                                                                                                             | —                                                 |

## Known gaps

**Reasoning quality**

- Prompts and schemas were written before any live model saw them. Expect further contract
  failures on first contact; failed runs keep the rejected output
  (`analysis_runs.output_json.rejected`) precisely so prompts and schemas can be tuned.
- One provider serves every pass; per-role routing is designed for but not built.
- The epistemic pass cannot search. A live model cites sources from memory, which may be
  wrong: evidence items are claims to check, not verified citations. The UI does not yet
  distinguish checked from unchecked sources.
- In discussion the provider replies but cannot propose typed actions for one-click use.

**Workflow**

- Analysis runs once per idea. Items added during review are not themselves explored,
  checked or challenged. An incremental "analyse this item" pass is the natural next step,
  for the CLI first.
- Relations cannot be added by hand, and cannot be retracted (append-only; a retraction
  record would be needed, not deletion).
- Guided sessions end when the tutor runs out of questions.

**Platform**

- Single user, single machine, SQLite only; no user accounts. The local token protects
  against other web pages, not against other programs running as the same user.
- Staleness is per idea, not per item: any change to an idea invalidates reasoning in
  flight for that idea, including changes that would not have mattered. Simple and safe,
  occasionally wasteful (a live pass can take a minute or more).
- Jobs run inside the server process. If the server is not running, queued jobs wait.
- The live view polls every 2 s while visible; there is no push channel.
- No MCP server yet (the agent API is shaped for one). No export/import. No end-to-end
  browser test suite; the UI is verified by hand plus unit tests of its pure logic.
- Ideas cannot be deleted or archived through the app.

## Next steps (suggested order)

1. **Tune the live passes**, including builder and synthesis: run them with `claude-cli`,
   read the rejected outputs, adjust prompts/schemas, add recorded-fixture tests per pass.
2. **Incremental analysis from the CLI**: a pass contract scoped to one item.
3. **MCP adapter** over `src/agent-api/commands.ts`, so agents get typed tools instead of
   shelling out.
4. **Evidence checking**: mark sources as unchecked/checked, and let the user or a
   search-capable agent verify them.
5. **Export** a synthesis with its provenance trail to Markdown; then the NPO curriculum
   lesson (see `.claude/CLAUDE.md` §11).

Smaller: a Codex subscription adapter once `codex exec` can be verified; agent-proposed
actions in discussion; manual relations; Playwright smoke test; archive/hide ideas;
per-role model routing; a push channel.
