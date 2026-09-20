/**
 * Scripted mock output for the motivating "pyramids" idea.
 *
 * This exists to demonstrate the workflow and the graph, NOT to assert history. Every
 * verdict below is illustrative; no sources were consulted. The rationale text says so.
 */
import type { EpistemicOutput, ExtractOutput } from '../schemas';
import type { FixtureItem } from './helpers';

export const PYRAMIDS_TEXT =
  'Large projects such as Egyptian pyramid construction appear to require specialization, ' +
  'administration, engineering and technological development. Even if the final product itself ' +
  'has little practical economic utility, perhaps undertaking a difficult collective project can ' +
  'develop useful capabilities. If so, could societies deliberately choose similarly demanding ' +
  'projects whose final outputs are themselves socially useful?';

export const isPyramidsIdea = (text: string) => /pyramid/i.test(text);

const DEMO = '(Demo verdict: illustrative only, no sources were consulted.)';

const Q1 =
  'Large projects such as Egyptian pyramid construction appear to require specialization, administration, engineering and technological development.';
const Q2 = 'the final product itself has little practical economic utility';
const Q3 = 'perhaps undertaking a difficult collective project can develop useful capabilities';
const Q4 =
  'could societies deliberately choose similarly demanding projects whose final outputs are themselves socially useful?';

export const pyramidsExtract: ExtractOutput['items'] = [
  {
    key: 'e_requires',
    kind: 'factual_claim',
    text: 'Building the pyramids required specialisation, administration, engineering and technological development.',
    source_quotes: [Q1],
    links: [],
    needs_user: false,
    is_tangent: false,
  },
  {
    key: 'e_caused',
    kind: 'causal_claim',
    text: "Building the pyramids caused Egypt's administrative and technological development.",
    source_quotes: [Q1, Q3],
    links: [],
    needs_user: false,
    is_tangent: false,
  },
  {
    key: 'e_utility',
    kind: 'value_judgment',
    text: 'The pyramids themselves had little practical economic utility.',
    source_quotes: [Q2],
    links: [],
    needs_user: false,
    is_tangent: false,
  },
  {
    key: 'e_hypothesis',
    kind: 'hypothesis',
    text: 'Undertaking a difficult collective project can develop useful capabilities even when its final product is not useful.',
    source_quotes: [Q3],
    links: [],
    needs_user: false,
    is_tangent: false,
  },
  {
    key: 'e_transfer',
    kind: 'assumption',
    text: 'Capabilities developed for one project transfer to other uses.',
    source_quotes: [Q3],
    links: [{ type: 'assumes', to: 'e_hypothesis', direction: 'in' }],
    needs_user: false,
    is_tangent: false,
  },
  {
    key: 'e_question',
    kind: 'question',
    text: 'Could societies deliberately choose demanding projects whose outputs are themselves socially useful?',
    source_quotes: [Q4],
    links: [{ type: 'derived_from', to: 'e_hypothesis', direction: 'out' }],
    needs_user: false,
    is_tangent: false,
  },
];

export const pyramidsExplore: FixtureItem[] = [
  {
    key: 'x_survivor',
    kind: 'question',
    text: 'Even if pyramid building did not cause Egyptian development: can large collective projects accelerate specialisation, coordination and technological learning when their product has little direct economic utility?',
    links: [{ type: 'derived_from', to: 'e_caused' }],
  },
  {
    key: 'x_coordination',
    kind: 'implication',
    text: 'Large projects may act as coordination mechanisms: a shared, legible goal lets a society organise labour, logistics and administration at a scale it would not otherwise attempt.',
    links: [{ type: 'derived_from', to: 'e_hypothesis' }],
  },
  {
    key: 'x_spillovers',
    kind: 'extension',
    text: 'Technological spillovers: techniques and institutions built for a flagship project may spread to unrelated uses, as is often claimed for the Apollo programme.',
    links: [
      { type: 'derived_from', to: 'e_hypothesis' },
      { type: 'supports', to: 'e_transfer' },
    ],
  },
  {
    key: 'x_wartime',
    kind: 'analogy',
    text: 'Wartime mobilisation looks like the same mechanism: an urgent collective goal forces rapid specialisation, coordination and technical learning.',
    links: [{ type: 'derived_from', to: 'e_hypothesis' }],
  },
  {
    key: 'x_without_war',
    kind: 'question',
    text: 'Can the mobilisation effects of war be reproduced without war, for example through "moonshot" projects with socially useful outputs?',
    links: [
      { type: 'derived_from', to: 'x_wartime' },
      { type: 'derived_from', to: 'e_question' },
    ],
  },
  {
    key: 'x_games',
    kind: 'question',
    text: 'Can simulated conflict, such as competitive video games, provide some of the psychological or social functions of real conflict without physical harm?',
    links: [{ type: 'tangent_of', to: 'x_wartime' }],
    is_tangent: true,
  },
];

export const pyramidsEpistemic = {
  assessments: [
    {
      item: 'e_requires',
      verdict: 'well_supported',
      rationale: `Large-scale construction plainly needs organised labour, logistics and engineering. ${DEMO}`,
    },
    {
      item: 'e_caused',
      verdict: 'probably_false',
      rationale: `As a one-way causal claim this probably runs the wrong way round: a state needs considerable administrative capacity before it can attempt a pyramid at all. ${DEMO}`,
    },
    {
      item: 'e_utility',
      verdict: 'normative',
      rationale: `Whether the pyramids were "useful" depends on what counts as utility (religious and political legitimacy versus economic output). That is partly a value judgement, so it needs your view rather than a ruling. ${DEMO}`,
    },
    {
      item: 'e_hypothesis',
      verdict: 'plausible_uncertain',
      rationale: `Plausible as a mechanism, but the supporting cases are easy to cherry-pick. ${DEMO}`,
    },
    {
      item: 'e_transfer',
      verdict: 'plausible_uncertain',
      rationale: `Transfer is the crux of the argument and is more often assumed than shown. ${DEMO}`,
    },
    {
      item: 'x_spillovers',
      verdict: 'disputed',
      rationale: `The size of Apollo-style spillovers is contested; some argue the same money spent directly would have yielded more. ${DEMO}`,
    },
  ],
  corrections: [
    {
      key: 'c_coevolution',
      kind: 'correction',
      text: 'State capacity probably came first and then co-evolved with construction: Egypt needed substantial administrative capacity to attempt pyramids at all, and building them may then have reinforced and extended it. Mutual reinforcement fits better than one-way causation.',
      links: [{ type: 'corrects', to: 'e_caused' }],
      needs_user: true,
      attention_reason: 'disputed_correction',
    },
  ],
  evidence: [
    {
      key: 'ev_placeholder',
      text: 'Placeholder: administrative titles and provincial organisation are said to predate the largest pyramids.',
      stance: 'against',
      about: 'e_caused',
      source_title: 'DEMO PLACEHOLDER - not a real citation; replace with a real source',
    },
  ],
  flags: [{ item: 'e_utility', reason: 'value_judgment_input' }],
} satisfies {
  assessments: EpistemicOutput['assessments'];
  corrections: FixtureItem[];
  evidence: Array<Omit<EpistemicOutput['evidence'][number], 'url' | 'excerpt'>>;
  flags: EpistemicOutput['flags'];
};

export const pyramidsAdversarial: FixtureItem[] = [
  {
    key: 'a_interpretation',
    kind: 'question',
    text: 'There are two plausible readings of your idea: (A) demanding projects create capability that was not there before, or (B) they exercise and reveal capability that already existed. Which did you mean?',
    links: [{ type: 'questions', to: 'e_hypothesis' }],
    needs_user: true,
    attention_reason: 'ambiguous_interpretation',
  },
  {
    key: 'a_selection',
    kind: 'objection',
    text: 'Selection effect: we remember societies whose giant projects coincided with flourishing. Ruinous or abandoned megaprojects are far less visible, so the pattern may be an artefact of which cases come to mind.',
    links: [{ type: 'qualifies', to: 'e_hypothesis' }],
    needs_user: true,
    attention_reason: 'unresolved_objection',
  },
  {
    key: 'a_common_cause',
    kind: 'objection',
    text: 'Alternative explanation: a third factor, such as agricultural surplus under a centralised state, could cause both the large projects and the capability growth, with no causal link between the two.',
    links: [
      { type: 'contradicts', to: 'e_hypothesis' },
      { type: 'contradicts', to: 'x_coordination' },
    ],
    needs_user: true,
    attention_reason: 'unresolved_objection',
  },
  {
    key: 'a_persistence',
    kind: 'assumption',
    text: 'Hidden assumption: capability gains persist after the project ends, rather than dispersing when the workforce does.',
    links: [{ type: 'assumes', to: 'e_hypothesis', direction: 'in' }],
    needs_user: true,
    attention_reason: 'unresolved_assumption',
  },
  {
    key: 'a_opportunity_cost',
    kind: 'question',
    text: 'Opportunity cost: would the same resources have produced more capability if spent directly on useful things?',
    links: [{ type: 'questions', to: 'e_question' }],
  },
  {
    key: 'a_what_would_change',
    kind: 'question',
    text: 'What evidence would change the conclusion? For example, comparable societies with similar surplus that built no megaprojects yet developed just as quickly.',
    links: [{ type: 'questions', to: 'e_hypothesis' }],
  },
];

export const pyramidsBuilder: FixtureItem[] = [
  {
    key: 'b_reformulation',
    kind: 'hypothesis',
    text: "Demanding collective projects can accelerate specialisation, coordination and technical learning when the skills are transferable and the institutions outlast the project, whether or not the project's product is itself useful. They reinforce existing capacity rather than create it from nothing.",
    links: [
      { type: 'derived_from', to: 'e_hypothesis' },
      { type: 'derived_from', to: 'x_survivor' },
      { type: 'derived_from', to: 'c_coevolution' },
    ],
    requiresLive: ['e_hypothesis', 'x_survivor'],
  },
  {
    key: 'b_distinction',
    kind: 'distinction',
    text: 'Distinguish three things a megaproject might do: create capability, exercise existing capability, and display capability. Only the first supports the strong version of the idea.',
    links: [
      { type: 'derived_from', to: 'a_interpretation' },
      { type: 'qualifies', to: 'b_reformulation' },
    ],
    requiresLive: ['a_interpretation', 'e_hypothesis'],
  },
  {
    key: 'b_test',
    kind: 'test',
    text: 'Possible test: compare capability trajectories of societies that did and did not undertake megaprojects, holding surplus and state capacity roughly constant, and include the failed projects.',
    links: [
      { type: 'derived_from', to: 'a_common_cause' },
      { type: 'derived_from', to: 'a_selection' },
    ],
    requiresLive: ['a_common_cause', 'a_selection'],
  },
  {
    key: 'b_mechanism',
    kind: 'implication',
    text: 'Connection between branches: coordination around a legible shared goal may be the common mechanism behind both wartime mobilisation and peaceful "moonshots".',
    links: [
      { type: 'derived_from', to: 'x_coordination' },
      { type: 'derived_from', to: 'x_without_war' },
    ],
    requiresLive: ['x_coordination', 'x_without_war'],
  },
  {
    key: 'b_examples',
    kind: 'example',
    text: 'Candidate demanding projects with useful outputs: disease eradication campaigns, energy-transition infrastructure, open scientific instruments.',
    links: [{ type: 'derived_from', to: 'e_question' }],
    requiresLive: ['e_question'],
  },
];
