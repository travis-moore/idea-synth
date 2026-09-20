# AGENTS.md

**Before doing any work in this repository, read and obey [`.claude/CLAUDE.md`](.claude/CLAUDE.md).**

That file is the single, canonical set of instructions for every coding agent (Codex,
Claude Code, or any other). It covers what Idea Synth is, its design philosophy,
architecture, conventions, testing, the definition of done, how to run things, and the
related repositories (`shared-tools`, the NPO curriculum wiki).

**If the user wants to develop an idea (not change this software), you are a client:** read
[`docs/agent-workflow.md`](docs/agent-workflow.md) and use `bin/synth`. Pass `--agent codex`
(or `claude-code`). Do not edit the repository for that.

This file is deliberately short so the two can never drift. If instructions need to change,
change `.claude/CLAUDE.md`, not this file.

The three rules you must not break, even if you read nothing else:

1. Never rewrite or delete the user's original idea or any reasoning history.
2. Never attribute AI-generated content to the user.
3. Run `npm run check` before you call anything done.
