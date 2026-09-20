import type { ModelProvider, StructuredRequest } from '../provider';
import { ProviderError } from '../provider';
import type { DiscussInput, IdeaSnapshot, TutorAssessInput, TutorMoveInput } from '../passes';
import type { DiscussOutput, EpistemicOutput } from '../schemas';
import { genericAdversarial, genericEpistemic, genericExplore, genericExtract } from './generic';
import { byRunKey, resolveFixture, short } from './helpers';
import {
  isPyramidsIdea,
  pyramidsAdversarial,
  pyramidsBuilder,
  pyramidsEpistemic,
  pyramidsExplore,
  pyramidsExtract,
} from './pyramids';
import { genericBuilder, mockSynthesize } from './synthesis';
import { mockAssess, mockMove } from './tutor';

function pyramidsEpistemicOutput(s: IdeaSnapshot): EpistemicOutput {
  const id = (key: string) => byRunKey(s, key)?.id;
  return {
    assessments: pyramidsEpistemic.assessments.flatMap((a) => {
      const item = id(a.item);
      return item ? [{ ...a, item }] : [];
    }),
    corrections: resolveFixture(s, pyramidsEpistemic.corrections).map((c) => ({
      needs_user: false,
      is_tangent: false,
      ...c,
      links: c.links.map((l) => ({ direction: 'out' as const, ...l })),
    })),
    evidence: pyramidsEpistemic.evidence.flatMap((e) => {
      const about = id(e.about);
      return about && !byRunKey(s, e.key) ? [{ ...e, about }] : [];
    }),
    flags: pyramidsEpistemic.flags.flatMap((f) => {
      const item = id(f.item);
      return item ? [{ ...f, item }] : [];
    }),
  };
}

const DISCUSS_PROMPTS: Record<string, string> = {
  objection: 'If this objection is right, does your idea fail, or does it only need narrowing?',
  correction: 'Does the corrected version still support the idea you care about?',
  assumption: 'What would the argument look like if this assumption were false?',
  value_judgment: 'This one is yours to call. What matters to you here, and why?',
  question: 'What would a good answer to this question let you conclude?',
  causal_claim: 'What else could explain the same observations?',
};

function mockDiscuss(input: DiscussInput): DiscussOutput {
  const last = [...input.thread].reverse().find((m) => m.author === 'user');
  const prompt = DISCUSS_PROMPTS[input.item.kind] ?? 'What would change your mind about this item?';
  return {
    reply:
      `[mock reply] You said: "${short(last?.body ?? '', 160)}". ` +
      `I can't evaluate that in demo mode, but here is a question that usually helps with a ${input.item.kind.replaceAll('_', ' ')}: ${prompt}`,
    suggestion:
      'When you have a view, record it: accept, qualify (say what the limits are), reject, split it, or set it aside as a tangent.',
  };
}

/**
 * Deterministic provider for demos and tests: same input, same output, no network.
 * Its output goes through the same schema validation as a live model's.
 */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly model = 'deterministic-mock-1';
  readonly live = false;

  async generate<T>(request: StructuredRequest<T>): Promise<unknown> {
    const key = `${request.pass}:${request.task}`;
    switch (key) {
      case 'tutor:assess':
        return mockAssess(request.input as TutorAssessInput);
      case 'tutor:move':
        return mockMove(request.input as TutorMoveInput);
      case 'discuss:discuss':
        return mockDiscuss(request.input as DiscussInput);
    }
    const s = request.input as IdeaSnapshot;
    const scripted = isPyramidsIdea(s.idea.originalText);
    switch (key) {
      case 'extract:extract':
        return scripted ? { items: pyramidsExtract } : genericExtract(s);
      case 'explore:explore':
        return scripted ? { items: resolveFixture(s, pyramidsExplore) } : genericExplore(s);
      case 'epistemic:epistemic':
        return scripted ? pyramidsEpistemicOutput(s) : genericEpistemic(s);
      case 'adversarial:adversarial':
        return scripted ? { items: resolveFixture(s, pyramidsAdversarial) } : genericAdversarial(s);
      case 'builder:builder':
        return scripted ? { items: resolveFixture(s, pyramidsBuilder) } : genericBuilder(s);
      case 'synthesize:synthesize':
        return mockSynthesize(s);
      default:
        throw new ProviderError(`mock provider has no handler for ${key}`);
    }
  }
}
