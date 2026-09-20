# AI provider abstraction

The domain is not coupled to Claude, OpenAI or any model. A provider is anything that
implements one method:

```ts
interface ModelProvider {
  readonly name: string; // recorded on every run
  readonly model: string; // recorded on every run
  readonly live: boolean; // false → the UI shows the demo-mode banner
  generate<T>(request: StructuredRequest<T>): Promise<unknown>; // returns UNVALIDATED data
}
```

A `StructuredRequest` carries the pass name, a task name, the prompt version, a system
prompt, a rendered user prompt, the same information as structured `input`, and the zod
schema the answer must satisfy.

## Passes

| Pass                       | Role     | Output schema (`src/ai/schemas.ts`)                | May create                                                                          |
| -------------------------- | -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `extract`                  | neutral  | `extractOutputSchema`                              | extractable kinds, each with `source_quotes`                                        |
| `explore`                  | Explorer | `exploreOutputSchema`                              | implication, extension, question, analogy, hypothesis                               |
| `epistemic`                | Skeptic  | `epistemicOutputSchema`                            | assessments, `correction` items, evidence, flags                                    |
| `adversarial`              | Skeptic  | `adversarialOutputSchema`                          | objection, question, assumption, uncertainty, flags                                 |
| `builder`                  | Builder  | `builderOutputSchema`                              | hypothesis, example, test, distinction, question, implication, extension, inference |
| `synthesize`               | Builder  | `synthesizeOutputSchema`                           | synthesis body; every line needs ≥ 1 item ref                                       |
| `discuss`                  | neutral  | `discussOutputSchema`                              | a reply and an optional suggestion (never a decision)                               |
| `tutor` (`assess`, `move`) | Tutor    | `tutorAssessOutputSchema`, `tutorMoveOutputSchema` | adequacy judgement; next move at the level the app chose                            |

Prompts live in `src/ai/passes.ts` and share a preamble encoding the educational
philosophy. `PROMPT_VERSION` is stored on every run; bump it when wording changes.

## Validation

`commitPass` (`src/services/pipeline.ts`) treats every reasoner the same way:

1. output arrives as `unknown` (from `provider.generate`, or from `passes.submit`)
2. `request.schema.parse(...)` — shape, enums, required provenance
3. semantic checks while applying: every reference must be an existing item of this idea
   or a key from the same output; kinds **and edge types** must be within the pass's remit
   (a model may never write `supersedes`, `merged_into`, `branches_to`, `synthesized_into`,
   `answers` or evidence edges, and only `assumes` may point at a new item); non-extract
   items must link to what they arose from; extracted items need a quote that is really in
   the user's text to count as the user's; a supplied premise is only legal at level 5
4. in **one `BEGIN IMMEDIATE` transaction**: the idea must still be at the input version
   the request was built from (else a `stale` run is recorded and nothing is applied), the
   pass must still be the legal next one, the review gate must hold; then the run row and
   the changes are written together

Any failure rolls the pass back and records a `failed` run with the reason. The API
answers 502 with a readable message. Nothing is parsed out of prose.

## Reasoners

Validation and application do not care who reasoned. There are two kinds of reasoner:

- **The external agent** (Claude Code or Codex in a VS Code panel). It gets a pass contract
  from `synth passes.next`, reasons in its own conversation, and submits with
  `synth passes.submit`. Runs are recorded with `provider = <agent name>`,
  `model_source = self_reported`, `auth_mode = external_session`. See
  [agent-workflow.md](agent-workflow.md). This is the primary path and needs no provider.
- **A configured provider**, used only for web-triggered work (as durable jobs):

| Provider                                 | Notes                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none` (default)                         | Viewer mode. `canReason = false`; reasoning endpoints answer 409.                                                                                                                                                               |
| `mock` (`src/ai/mock/`)                  | Deterministic, offline, labelled demo data; what the test suite uses. Pyramids fixture, honest `[mock]` heuristics for other text, state-driven Builder/Synthesis that never reports confidence above `moderate`.               |
| `claude-cli` (`providers/claude-cli.ts`) | The user's installed Claude Code CLI, headless, under their subscription login: no tools, no settings, billing env withheld, login verified through the CLI. **Verified live** (see roadmap). [local-agent.md](local-agent.md). |
| `anthropic` (`providers/anthropic.ts`)   | Official SDK, structured outputs, default `claude-opus-5`. Unit-tested with a faked client; **never run against the live API**.                                                                                                 |

There is no fallback between providers. Every provider reports `info()` (name, model, how
the model name is known, auth mode; never a secret), honours an `AbortSignal`, and fails
with a `ProviderError` code (`not_logged_in`, `wrong_auth_mode`, `usage_limit`,
`invalid_output`, `process_failed`, `timeout`, `cancelled`, ...).

## Adding or routing providers

1. Implement `ModelProvider` in `src/ai/providers/<name>.ts`.
2. Add a case to `createProvider` in `src/ai/index.ts` and document its env vars in
   `.env.example`.
3. To use different models per role, write a small routing provider that picks a delegate
   from `request.pass` (`ROLE_OF_PASS` maps passes to Explorer / Skeptic / Builder / Tutor).

Secrets come only from the environment (`.env` is git-ignored).
