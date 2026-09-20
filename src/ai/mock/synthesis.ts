/**
 * State-driven mock Builder and Synthesiser. They read the *current* reasoning state
 * (what the user accepted, qualified, rejected) rather than replaying a script, so the
 * demo synthesis genuinely reflects the review gate.
 */
import { premiseFailed, productiveDescendants } from '../../domain/rules';
import type { ItemKind } from '../../domain/vocabulary';
import type { IdeaSnapshot, ItemSnapshot } from '../passes';
import type { BuilderOutput, SynthesizeOutput } from '../schemas';
import { byRunKey, isLive, short } from './helpers';

const TAG = '[mock]';

export function genericBuilder(s: IdeaSnapshot): BuilderOutput {
  const items: BuilderOutput['items'] = [];
  const survivors = s.items.filter(
    (i) => isLive(i) && ['hypothesis', 'causal_claim'].includes(i.kind) && !premiseFailed(i),
  );
  survivors.slice(0, 2).forEach((item, n) => {
    const key = `b_test_${n + 1}`;
    if (byRunKey(s, key)) return;
    items.push({
      key,
      kind: 'test',
      text: `${TAG} Possible test for "${short(item.text, 70)}": name one observation that would count for it and one that would count against it.`,
      links: [{ type: 'derived_from', to: item.id, direction: 'out' }],
      needs_user: false,
      is_tangent: false,
    });
  });
  return { items };
}

const CONCLUSION_KINDS: ItemKind[] = [
  'hypothesis',
  'implication',
  'extension',
  'causal_claim',
  'factual_claim',
  'inference',
  'distinction',
  'correction',
];
const UNCERTAIN_VERDICTS = [
  'plausible_uncertain',
  'disputed',
  'unsupported',
  'requires_clarification',
  'misleading_framing',
];

export function mockSynthesize(s: IdeaSnapshot): SynthesizeOutput {
  const root = s.items.find((i) => i.kind === 'original_idea');
  if (!root) throw new Error('mock synthesiser: idea has no original_idea item');
  const targetsOf = (item: ItemSnapshot, type: string) =>
    s.relations.filter((r) => r.fromItemId === item.id && r.type === type).map((r) => r.toItemId);
  const withQualification = (i: ItemSnapshot) =>
    i.status === 'qualified' && i.qualification
      ? `${i.text} (Qualified by you: ${i.qualification})`
      : i.text;

  const settled = s.items.filter((i) => i.status === 'accepted' || i.status === 'qualified');

  const what_changed = [
    ...settled
      .filter((i) => i.kind === 'correction')
      .map((c) => ({
        text: `Correction taken on board: ${withQualification(c)}`,
        refs: [c.id, ...targetsOf(c, 'corrects')],
      })),
    ...s.items
      .filter((i) => ['split', 'merged', 'superseded'].includes(i.status))
      .map((i) => ({ text: `"${short(i.text)}" was ${i.status} during review.`, refs: [i.id] })),
  ];

  const rejected = s.items
    .filter((i) => i.status === 'rejected')
    .map((i) => {
      const survivors = productiveDescendants(i.id, s.items, s.relations);
      return {
        text:
          `Rejected: "${short(i.text)}"` +
          (survivors.length > 0
            ? ' It was a productive mistake: ideas that arose from it survive.'
            : ''),
        refs: [i.id, ...survivors],
      };
    });

  const uncertain = [
    ...s.items
      .filter((i) => isLive(i) && premiseFailed(i))
      .map((i) => ({
        text: `The epistemic review found "${short(i.text)}" ${i.epistemicVerdict?.replace('_', ' ')}, and you have not rejected it.`,
        refs: [i.id],
      })),
    ...s.items
      .filter(
        (i) => isLive(i) && i.epistemicVerdict && UNCERTAIN_VERDICTS.includes(i.epistemicVerdict),
      )
      .map((i) => ({
        text: `${i.epistemicVerdict?.replaceAll('_', ' ')}: "${short(i.text)}"`,
        refs: [i.id],
      })),
    ...s.items
      .filter((i) => i.kind === 'objection' && (i.status === 'open' || i.status === 'needs_user'))
      .map((i) => ({ text: `Unanswered objection: ${short(i.text, 140)}`, refs: [i.id] })),
  ].slice(0, 8);

  const conclusionSources = settled
    .filter((i) => CONCLUSION_KINDS.includes(i.kind) && !premiseFailed(i))
    .slice(0, 6);
  let conclusions: SynthesizeOutput['conclusions'] = conclusionSources.map((i, n) => ({
    key: `s_conclusion_${n + 1}`,
    text: withQualification(i),
    refs: [i.id],
    confidence:
      i.status === 'accepted' && i.epistemicVerdict === 'well_supported' ? 'moderate' : 'tentative',
  }));
  if (conclusions.length === 0) {
    const candidate = s.items.find(
      (i) => isLive(i) && i.kind === 'hypothesis' && !premiseFailed(i),
    );
    conclusions = [
      {
        key: 's_conclusion_1',
        text: candidate
          ? `Nothing has been accepted yet. The leading open candidate is: ${candidate.text}`
          : 'Nothing has been accepted yet, so there is no conclusion to defend.',
        refs: [candidate?.id ?? root.id],
        confidence: 'tentative',
      },
    ];
  }

  const evidence = s.items
    .filter((i) => i.kind === 'evidence' && i.status !== 'rejected')
    .map((i) => ({
      text: i.text,
      refs: [i.id, ...targetsOf(i, 'evidence_for'), ...targetsOf(i, 'evidence_against')],
    }));

  const open_questions = s.items
    .filter((i) => isLive(i) && i.kind === 'question' && i.status !== 'accepted')
    .slice(0, 8)
    .map((i) => ({ text: i.text, refs: [i.id] }));

  const used = new Set(conclusions.flatMap((c) => c.refs));
  const tangents = s.items
    .filter(
      (i) => i.status === 'open' && ['analogy', 'extension'].includes(i.kind) && !used.has(i.id),
    )
    .map((i) => ({
      item: i.id,
      reason: 'Interesting, but it was not taken into the main line of reasoning during review.',
    }));

  const reformulation = s.items.find(
    (i) =>
      isLive(i) && i.kind === 'hypothesis' && i.origin === 'agent' && i.runKey?.startsWith('b_'),
  );
  const statement =
    settled.length === 0
      ? `${TAG} No items have been accepted yet, so this is a snapshot rather than a conclusion. ${conclusions[0]?.text ?? ''}`
      : reformulation
        ? reformulation.text +
          (reformulation.status === 'open'
            ? ' (This formulation was proposed by the Builder; you have not accepted it yet.)'
            : '')
        : (conclusions[0]?.text ?? '');

  return {
    statement,
    initial_thought: {
      text: `You started from: "${short(s.idea.originalText, 240)}"`,
      refs: [root.id],
    },
    what_changed,
    rejected,
    uncertain,
    conclusions,
    evidence,
    open_questions,
    tangents,
  };
}
