/**
 * Heuristic mock passes for arbitrary text. They cannot understand the idea; they
 * produce honest, clearly labelled placeholders so the whole workflow can be exercised
 * on any input without a live model.
 */
import type { ItemKind } from '../../domain/vocabulary';
import type { IdeaSnapshot } from '../passes';
import type { AdversarialOutput, EpistemicOutput, ExploreOutput, ExtractOutput } from '../schemas';
import { isLive, short } from './helpers';

const TAG = '[mock]';

export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? [text])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function classify(sentence: string): ItemKind {
  const s = sentence.toLowerCase();
  if (s.endsWith('?')) return 'question';
  if (/\b(should|ought|good|bad|better|worse|wrong|right|deserve|fair|unfair)\b/.test(s))
    return 'value_judgment';
  if (/\b(because|causes?|caused|leads? to|led to|results? in|due to|means that|makes?)\b/.test(s))
    return 'causal_claim';
  if (/\b(like|similar to|just as|as if|resembles?)\b/.test(s)) return 'analogy';
  if (/\b(maybe|perhaps|might|could|possibly|i think|i suspect|probably|what if|will)\b/.test(s))
    return 'hypothesis';
  if (/\b(not sure|unsure|don't know|unclear)\b/.test(s)) return 'uncertainty';
  if (/\b(therefore|so|thus|hence|it follows)\b/.test(s)) return 'inference';
  return 'factual_claim';
}

export function genericExtract(s: IdeaSnapshot): ExtractOutput {
  const items = splitSentences(s.idea.originalText).map((sentence, i) => ({
    key: `e_${i + 1}`,
    kind: classify(sentence),
    text: sentence,
    source_quotes: [sentence],
    links: [],
    needs_user: false,
    is_tangent: false,
  }));
  return { items };
}

const extracted = (s: IdeaSnapshot) => s.items.filter((i) => i.origin === 'extracted_from_user');

export function genericExplore(s: IdeaSnapshot): ExploreOutput {
  const all = extracted(s);
  const seeds = all.filter((i) => ['hypothesis', 'causal_claim', 'factual_claim'].includes(i.kind));
  const chosen = (seeds.length > 0 ? seeds : all).slice(0, 3);
  const items: ExploreOutput['items'] = [];
  chosen.forEach((item, n) => {
    items.push({
      key: `x_survives_${n + 1}`,
      kind: 'question',
      text: `${TAG} Even if "${short(item.text, 70)}" turns out to be false, what nearby idea could still be true and interesting?`,
      links: [{ type: 'derived_from', to: item.id, direction: 'out' }],
      needs_user: false,
      is_tangent: false,
    });
    items.push({
      key: `x_implies_${n + 1}`,
      kind: 'implication',
      text: `${TAG} If "${short(item.text, 70)}" holds, what else should we expect to see? (Placeholder implication: a live model would propose one.)`,
      links: [{ type: 'derived_from', to: item.id, direction: 'out' }],
      needs_user: false,
      is_tangent: false,
    });
  });
  return { items };
}

export function genericEpistemic(s: IdeaSnapshot): EpistemicOutput {
  const assessments: EpistemicOutput['assessments'] = [];
  const flags: EpistemicOutput['flags'] = [];
  for (const item of extracted(s)) {
    if (item.kind === 'factual_claim')
      assessments.push({
        item: item.id,
        verdict: 'requires_clarification',
        rationale: `${TAG} The mock provider cannot check facts. Treat this as unverified until you or a live model examine it.`,
      });
    else if (
      item.kind === 'causal_claim' ||
      item.kind === 'hypothesis' ||
      item.kind === 'inference'
    )
      assessments.push({
        item: item.id,
        verdict: 'plausible_uncertain',
        rationale: `${TAG} Causal and hypothetical claims default to "plausible but uncertain" in demo mode.`,
      });
    else if (item.kind === 'value_judgment') {
      assessments.push({
        item: item.id,
        verdict: 'normative',
        rationale: `${TAG} This reads as a value judgement, which evidence alone cannot settle.`,
      });
      flags.push({ item: item.id, reason: 'value_judgment_input' });
    }
  }
  return { assessments, corrections: [], evidence: [], flags };
}

export function genericAdversarial(s: IdeaSnapshot): AdversarialOutput {
  const live = s.items.filter((i) => isLive(i) && i.origin === 'extracted_from_user');
  const items: AdversarialOutput['items'] = [];
  live
    .filter((i) => i.kind === 'causal_claim')
    .slice(0, 2)
    .forEach((item, n) =>
      items.push({
        key: `a_alternative_${n + 1}`,
        kind: 'objection',
        text: `${TAG} Alternative explanation: could something else cause both sides of "${short(item.text, 70)}", or could the causation run the other way?`,
        links: [{ type: 'contradicts', to: item.id, direction: 'out' }],
        needs_user: true,
        attention_reason: 'unresolved_objection',
        is_tangent: false,
      }),
    );
  live
    .filter((i) => i.kind === 'hypothesis' || i.kind === 'factual_claim')
    .slice(0, 2)
    .forEach((item, n) =>
      items.push({
        key: `a_change_mind_${n + 1}`,
        kind: 'question',
        text: `${TAG} What evidence would change your mind about "${short(item.text, 70)}"?`,
        links: [{ type: 'questions', to: item.id, direction: 'out' }],
        needs_user: n === 0,
        attention_reason: n === 0 ? 'clarification_needed' : undefined,
        is_tangent: false,
      }),
    );
  if (items.length === 0 && live[0])
    items.push({
      key: 'a_generalisation',
      kind: 'objection',
      text: `${TAG} Is "${short(live[0].text, 70)}" an overgeneralisation? What is a case where it would not hold?`,
      links: [{ type: 'qualifies', to: live[0].id, direction: 'out' }],
      needs_user: true,
      attention_reason: 'unresolved_objection',
      is_tangent: false,
    });
  return { items, flags: [] };
}
