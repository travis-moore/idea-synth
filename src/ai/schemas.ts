/**
 * Output contracts for every reasoning pass.
 *
 * Providers return `unknown`; `executePass` validates it against these schemas before
 * anything is written. A model that answers in prose, invents a verdict or forgets a
 * reference fails validation and the run is recorded as failed - nothing half-applies.
 *
 * References (`ref`) are either the id of an existing item or the `key` of an item
 * created in the same output.
 */
import { z } from 'zod';
import {
  attentionReasonSchema,
  epistemicVerdictSchema,
  itemKindSchema,
  relationTypeSchema,
} from '../domain/vocabulary';
import { adequacySchema } from '../domain/scaffolding';

const text = z.string().trim().min(1).max(4000);
const ref = z.string().trim().min(1);

export const linkSchema = z.object({
  type: relationTypeSchema,
  /** The other end of the edge. */
  to: ref,
  /**
   * `out` (default): new item --type--> `to`.  `in`: `to` --type--> new item
   * (e.g. an existing claim `assumes` a newly surfaced assumption).
   */
  direction: z.enum(['out', 'in']).default('out'),
  note: z.string().max(500).optional(),
});
export type LinkOutput = z.infer<typeof linkSchema>;

export const newItemSchema = z.object({
  key: z.string().trim().min(1).max(64),
  kind: itemKindSchema,
  text,
  links: z.array(linkSchema).default([]),
  /** Ask the user about this item at the review gate. */
  needs_user: z.boolean().default(false),
  attention_reason: attentionReasonSchema.optional(),
  /** Interesting but off the main line: archive it as a tangent straight away. */
  is_tangent: z.boolean().default(false),
});
export type NewItemOutput = z.infer<typeof newItemSchema>;

const flagSchema = z.object({
  item: ref,
  reason: attentionReasonSchema,
  note: z.string().optional(),
});

export const extractOutputSchema = z.object({
  items: z
    .array(
      newItemSchema.extend({
        /** Verbatim passages of the original text this item was extracted from. */
        source_quotes: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});
export type ExtractOutput = z.infer<typeof extractOutputSchema>;

export const exploreOutputSchema = z.object({ items: z.array(newItemSchema) });
export type ExploreOutput = z.infer<typeof exploreOutputSchema>;

export const epistemicOutputSchema = z.object({
  assessments: z.array(z.object({ item: ref, verdict: epistemicVerdictSchema, rationale: text })),
  corrections: z.array(newItemSchema).default([]),
  evidence: z
    .array(
      z.object({
        key: z.string().min(1),
        text,
        stance: z.enum(['for', 'against']),
        about: ref,
        source_title: z.string().min(1),
        url: z.string().url().optional(),
        excerpt: z.string().optional(),
      }),
    )
    .default([]),
  flags: z.array(flagSchema).default([]),
});
export type EpistemicOutput = z.infer<typeof epistemicOutputSchema>;

export const adversarialOutputSchema = z.object({
  items: z.array(newItemSchema),
  flags: z.array(flagSchema).default([]),
});
export type AdversarialOutput = z.infer<typeof adversarialOutputSchema>;

export const builderOutputSchema = z.object({ items: z.array(newItemSchema) });
export type BuilderOutput = z.infer<typeof builderOutputSchema>;

/** Every synthesis line must point at the items it was built from. */
const tracedLine = z.object({ text, refs: z.array(ref).min(1) });

export const synthesizeOutputSchema = z.object({
  /** The strongest defensible form of the idea, as it currently stands. */
  statement: text,
  initial_thought: tracedLine,
  what_changed: z.array(tracedLine).default([]),
  rejected: z.array(tracedLine).default([]),
  uncertain: z.array(tracedLine).default([]),
  conclusions: z
    .array(
      tracedLine.extend({
        key: z.string().min(1),
        confidence: z.enum(['tentative', 'moderate', 'firm']),
      }),
    )
    .default([]),
  evidence: z.array(tracedLine).default([]),
  open_questions: z.array(tracedLine).default([]),
  /** Step 8: items to set aside in the tangent library. */
  tangents: z.array(z.object({ item: ref, reason: z.string() })).default([]),
});
export type SynthesizeOutput = z.infer<typeof synthesizeOutputSchema>;

export const discussOutputSchema = z.object({
  reply: text,
  /** A next step the user might take. A suggestion only: the agent never applies it. */
  suggestion: z.string().max(500).optional(),
});
export type DiscussOutput = z.infer<typeof discussOutputSchema>;

export const tutorAssessOutputSchema = z.object({
  adequacy: adequacySchema,
  /** Why the answer does or does not advance the reasoning, and what kind of answer would. */
  explanation: text,
  /** What kind of reasoning item the user's answer is, if it is worth keeping. */
  answer_kind: itemKindSchema.optional(),
});
export type TutorAssessOutput = z.infer<typeof tutorAssessOutputSchema>;

export const tutorMoveOutputSchema = z.object({
  /** The question being worked on (restated when `advance` moved to a new one). */
  question: text,
  /** Background the user needs in order to take part. Always shown as agent-supplied. */
  teaching: z.string().optional(),
  options: z.array(z.string().min(1)).optional(),
  /** Level 5 only: a premise the agent supplies. The user must accept, reject or modify it. */
  supplied_premise: z.object({ text, kind: itemKindSchema }).optional(),
  /** True when the tutor has no further questions and the idea can enter synthesis. */
  done: z.boolean().default(false),
});
export type TutorMoveOutput = z.infer<typeof tutorMoveOutputSchema>;
