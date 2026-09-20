/**
 * Builds the request for each reasoning pass: prompt text for live models, the same
 * information as structured `input` for the mock, and the schema the answer must meet.
 *
 * The educational philosophy is part of the prompts on purpose. Bump PROMPT_VERSION
 * whenever prompt wording changes; it is recorded on every run.
 */
import type { z } from 'zod';
import type {
  EpistemicVerdict,
  ItemKind,
  ItemStatus,
  Origin,
  Pass,
  RelationType,
} from '../domain/vocabulary';
import { SCAFFOLD_LEVELS, type ScaffoldLevel } from '../domain/scaffolding';
import type { StructuredRequest } from './provider';
import {
  adversarialOutputSchema,
  builderOutputSchema,
  discussOutputSchema,
  epistemicOutputSchema,
  exploreOutputSchema,
  extractOutputSchema,
  synthesizeOutputSchema,
  tutorAssessOutputSchema,
  tutorMoveOutputSchema,
} from './schemas';

export const PROMPT_VERSION = '2026-09-20.1';

export interface ItemSnapshot {
  id: string;
  runKey: string | null;
  kind: ItemKind;
  origin: Origin;
  status: ItemStatus;
  text: string;
  epistemicVerdict: EpistemicVerdict | null;
  /** The user's latest qualification, when status is `qualified`. */
  qualification: string | null;
}

export interface IdeaSnapshot {
  idea: {
    id: string;
    title: string;
    originalText: string;
    /** Who wrote the original text. `user` unless the idea is an un-reframed promoted tangent. */
    originalTextOrigin: Origin;
  };
  items: ItemSnapshot[];
  relations: Array<{ fromItemId: string; toItemId: string; type: RelationType }>;
  /** The idea revision this snapshot was read at. Echoed back when committing output. */
  inputVersion: number;
}

const PHILOSOPHY = `You are one reasoning pass inside Idea Synth, a tool that scaffolds a human's thinking
rather than replacing it. Rules that always apply:
- Generate freely, evaluate explicitly, preserve provenance.
- Never put beliefs into the user's mouth. Anything you add is yours and will be labelled as agent-originated.
- A false premise does not kill the ideas that arose from it. Keep productive branches alive.
- Distinguish evidence from inference, facts from values, "wrong" from "insufficiently supported".
- Make uncertainty visible. Do not manufacture certainty.
- Criticise arguments, never the person.
- Answer ONLY with JSON matching the provided schema. Reference existing items by their id.`;

const SYSTEM: Record<Pass, string> = {
  extract: `${PHILOSOPHY}
PASS: Extract (Step 2). Break the user's text into atomic or semi-atomic items (claims, hypotheses,
assumptions, analogies, value judgements, definitions, questions, inferences, uncertainties).
Stay faithful to what the user said. Every item must quote the passage(s) it came from verbatim.
Identifying a claim says nothing about whether it is true.`,
  explore: `${PHILOSOPHY}
PASS: Explorer (Step 3). Role: "What else follows from this?" Run BEFORE any criticism.
Find implications, questions, parallels and branches. Explicitly ask: what interesting ideas follow
from this even if one or more premises later turn out to be false? Use kind "implication" for what
follows from the user's idea and "extension" for your own proposals. Mark off-topic-but-interesting
items with is_tangent and a tangent_of link.`,
  epistemic: `${PHILOSOPHY}
PASS: Fact check / epistemic review (Step 4). Assess factual and causal claims with one verdict each.
Never rewrite the user's claim: propose a separate "correction" item linked with "corrects".
Attach evidence only when you can name a real source; otherwise say the claim requires research.
Flag value judgements for the user's view instead of ruling on them.`,
  adversarial: `${PHILOSOPHY}
PASS: Skeptic / adversarial review (Step 5). Role: "What here is not actually justified?"
Look for alternative causal explanations, hidden assumptions, missing variables, counterexamples,
selection effects, category mistakes, ambiguity, contradictions, overgeneralisation, unfalsifiable
claims, evidence that would change the conclusion, and the strongest opposing interpretation.
Set needs_user on objections the user must respond to before the reasoning can continue.`,
  builder: `${PHILOSOPHY}
PASS: Builder (Step 6). Role: "Given what survived, what is the strongest interesting version?"
Work ONLY from items that survived review (accepted, qualified or still open). Respect the user's
qualifications and rejections. Offer better formulations, examples, tests, distinctions, connections
between branches and better questions. Be constructive, not adversarial.`,
  synthesize: `${PHILOSOPHY}
PASS: Synthesis and tangent archive (Steps 7-8). Produce the strongest defensible form of the idea.
Separate: what the user initially thought, what changed, what was rejected, what remains uncertain,
which conclusions survive, what evidence supports them, which questions remain open. EVERY line must
list the ids of the items it rests on. List interesting off-main-line items under "tangents".`,
  discuss: `${PHILOSOPHY}
TASK: Discuss one reasoning item with the user. Help them think: ask what would change their mind,
point at the assumption doing the work, separate fact from value. You may suggest a next step
(accept, qualify, reject, split, branch, tangent) but the decision is always the user's.`,
  tutor: `${PHILOSOPHY}
TASK: Guided idea development. Scaffold; do not answer for the user unless the requested level says so.
Levels: ${Object.entries(SCAFFOLD_LEVELS)
    .map(([n, l]) => `${n}=${l.description}`)
    .join(' ')}
The level is chosen by the application, not by you. If the user lacks background knowledge, teach
just enough for them to keep taking part, and keep it labelled as yours. When an answer is
inadequate, explain why and what kind of answer would move the reasoning forward.`,
};

function renderItems(items: ItemSnapshot[]): string {
  if (items.length === 0) return '(no items yet)';
  return items
    .map(
      (i) =>
        `- [${i.id}] kind=${i.kind} origin=${i.origin} status=${i.status}` +
        (i.epistemicVerdict ? ` verdict=${i.epistemicVerdict}` : '') +
        `\n  ${i.text}` +
        (i.qualification ? `\n  user qualification: ${i.qualification}` : ''),
    )
    .join('\n');
}

function renderSnapshot(s: IdeaSnapshot): string {
  return [
    s.idea.originalTextOrigin === 'user'
      ? `ORIGINAL TEXT (the user's own words, never to be rewritten):\n"""${s.idea.originalText}"""`
      : `ORIGINAL TEXT (NOT the user's words: this idea was promoted from a tangent written by the agent. Do not attribute it to the user):\n"""${s.idea.originalText}"""`,
    `ITEMS:\n${renderItems(s.items)}`,
    `RELATIONS:\n${s.relations.map((r) => `- ${r.fromItemId} --${r.type}--> ${r.toItemId}`).join('\n') || '(none)'}`,
  ].join('\n\n');
}

function request<T>(
  pass: Pass,
  task: string,
  schema: z.ZodType<T>,
  prompt: string,
  input: unknown,
): StructuredRequest<T> {
  return { pass, task, promptVersion: PROMPT_VERSION, system: SYSTEM[pass], prompt, input, schema };
}

export const analysisRequests = {
  extract: (s: IdeaSnapshot) =>
    request('extract', 'extract', extractOutputSchema, renderSnapshot(s), s),
  explore: (s: IdeaSnapshot) =>
    request('explore', 'explore', exploreOutputSchema, renderSnapshot(s), s),
  epistemic: (s: IdeaSnapshot) =>
    request('epistemic', 'epistemic', epistemicOutputSchema, renderSnapshot(s), s),
  adversarial: (s: IdeaSnapshot) =>
    request('adversarial', 'adversarial', adversarialOutputSchema, renderSnapshot(s), s),
  builder: (s: IdeaSnapshot) =>
    request('builder', 'builder', builderOutputSchema, renderSnapshot(s), s),
  synthesize: (s: IdeaSnapshot) =>
    request('synthesize', 'synthesize', synthesizeOutputSchema, renderSnapshot(s), s),
};

export interface DiscussInput {
  snapshot: IdeaSnapshot;
  item: ItemSnapshot;
  thread: Array<{ author: 'user' | 'agent'; body: string }>;
}

export function discussRequest(input: DiscussInput) {
  const prompt = [
    renderSnapshot(input.snapshot),
    `ITEM UNDER DISCUSSION: [${input.item.id}] ${input.item.text}`,
    `THREAD SO FAR:\n${input.thread.map((m) => `${m.author.toUpperCase()}: ${m.body}`).join('\n')}`,
  ].join('\n\n');
  return request('discuss', 'discuss', discussOutputSchema, prompt, input);
}

export interface TutorTranscriptEntry {
  author: 'user' | 'agent';
  stepKind: string;
  level: number | null;
  body: string;
}

export interface TutorAssessInput {
  hypothesis: string;
  question: string;
  answer: string;
  level: ScaffoldLevel;
  transcript: TutorTranscriptEntry[];
}

export interface TutorMoveInput {
  hypothesis: string;
  /** Index of the question being worked on; increases when the policy advances. */
  questionIndex: number;
  /** The level of help the application's policy has selected for this move. */
  level: ScaffoldLevel;
  /** True when this move opens a new question. */
  advance: boolean;
  currentQuestion: string | null;
  transcript: TutorTranscriptEntry[];
}

const renderTranscript = (t: TutorTranscriptEntry[]) =>
  t
    .map(
      (e) =>
        `${e.author.toUpperCase()} (${e.stepKind}${e.level ? `, L${e.level}` : ''}): ${e.body}`,
    )
    .join('\n') || '(empty)';

export function tutorAssessRequest(input: TutorAssessInput) {
  const prompt = `HYPOTHESIS: ${input.hypothesis}\n\nTRANSCRIPT:\n${renderTranscript(input.transcript)}\n\nQUESTION: ${input.question}\nUSER ANSWER: ${input.answer}\n\nJudge how far this answer advances the reasoning.`;
  return request('tutor', 'assess', tutorAssessOutputSchema, prompt, input);
}

export function tutorMoveRequest(input: TutorMoveInput) {
  const prompt = `HYPOTHESIS: ${input.hypothesis}\n\nTRANSCRIPT:\n${renderTranscript(input.transcript)}\n\nProduce the next tutor move at scaffolding level ${input.level} (${SCAFFOLD_LEVELS[input.level].description}). ${input.advance ? 'Open the next useful question.' : `Keep working on: ${input.currentQuestion}`}`;
  return request('tutor', 'move', tutorMoveOutputSchema, prompt, input);
}
