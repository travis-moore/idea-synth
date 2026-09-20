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

`executePass` (`src/services/pipeline.ts`) treats every provider the same way:

1. `provider.generate(request)` → unknown
2. `request.schema.parse(...)` — shape, enums, required provenance
3. semantic checks while applying: every reference must be an existing item of this idea
   or a key from the same output; kinds **and edge types** must be within the pass's remit
   (a model may never write `supersedes`, `merged_into`, `branches_to`, `synthesized_into`,
   `answers` or evidence edges, and only `assumes` may point at a new item); non-extract
   items must link to what they arose from; extracted items need a quote that is really in
   the user's text to count as the user's; a supplied premise is only legal at level 5
4. apply in **one transaction** with the `analysis_runs` row

Any failure rolls the pass back and records a `failed` run with the reason. The API
answers 502 with a readable message. Nothing is parsed out of prose.

## Providers

**`MockProvider`** (`src/ai/mock/`, default). Deterministic, offline, free. It is what
demo mode and the whole test suite use.

- Ideas mentioning "pyramid" get a hand-written fixture (`pyramids.ts`) showing every
  feature: a probably-false causal premise with a surviving question, a disputed
  correction, a value judgement needing the user, an ambiguity, objections, a hidden
  assumption, placeholder evidence and a tangent. Its verdicts are illustrative and say so.
- Any other text gets honest heuristics (`generic.ts`): sentence splitting, keyword
  classification, and clearly `[mock]`-labelled placeholder questions.
- Builder and Synthesis (`synthesis.ts`) are **state-driven**: they read what the user
  actually accepted, qualified and rejected. With nothing accepted, the mock says there is
  no conclusion yet. It never reports confidence above `moderate`.

**`AnthropicProvider`** (`src/ai/providers/anthropic.ts`). Uses the official SDK with
structured outputs (`output_config.format = zodOutputFormat(schema)`), default model
`claude-opus-5` (override with `IDEA_SYNTH_MODEL`). Refusals, truncation, API errors and
non-JSON become `ProviderError`s. Unit-tested with a faked SDK client, and a test checks
that every pass schema converts to the JSON-schema format. **It has not been exercised
against the live API** (no key was available when it was written), so expect to tune
prompts and possibly schema constraints on first real use.

## Adding or routing providers

1. Implement `ModelProvider` in `src/ai/providers/<name>.ts`.
2. Add a case to `createProvider` in `src/ai/index.ts` and document its env vars in
   `.env.example`.
3. To use different models per role, write a small routing provider that picks a delegate
   from `request.pass` (`ROLE_OF_PASS` maps passes to Explorer / Skeptic / Builder / Tutor).

Secrets come only from the environment (`.env` is git-ignored).
