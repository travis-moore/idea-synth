/**
 * The remit of each reasoning pass: which kinds of item it may create and which edges it
 * may write. Enforced when output is applied (services/apply.ts) AND stated in every pass
 * contract (ai/passes.ts), so a reasoner is told the rule it will be held to.
 */
import { EXTRACTABLE_KINDS, type ItemKind, type RelationType } from './vocabulary';

/** What each pass is allowed to add. A model that strays outside fails validation. */
export const ALLOWED_KINDS: Record<
  'extract' | 'explore' | 'epistemic' | 'adversarial' | 'builder',
  readonly ItemKind[]
> = {
  extract: EXTRACTABLE_KINDS,
  explore: ['implication', 'extension', 'question', 'analogy', 'hypothesis'],
  epistemic: ['correction'],
  adversarial: ['objection', 'question', 'assumption', 'uncertainty'],
  builder: [
    'hypothesis',
    'example',
    'test',
    'distinction',
    'question',
    'implication',
    'extension',
    'inference',
  ],
};

export type ItemPass = keyof typeof ALLOWED_KINDS;

/**
 * Edge types a model may write. Structural genealogy (`supersedes`, `merged_into`,
 * `branches_to`, `synthesized_into`, `answers`) and evidence edges are only ever written
 * by the application as part of the operation they record, never on a model's say-so.
 */
const COMMON_LINKS: readonly RelationType[] = [
  'derived_from',
  'supports',
  'contradicts',
  'qualifies',
  'questions',
  'assumes',
];
export const ALLOWED_LINKS: Record<ItemPass, readonly RelationType[]> = {
  extract: COMMON_LINKS,
  explore: [...COMMON_LINKS, 'tangent_of'],
  epistemic: [...COMMON_LINKS, 'corrects'],
  adversarial: COMMON_LINKS,
  builder: COMMON_LINKS,
};
/** Only `assumes` may point *at* the new item (an existing claim assumes a new assumption). */
export const INBOUND_LINKS: readonly RelationType[] = ['assumes'];

/** The remit as a sentence, for prompts and CLI contracts. */
export function describeRemit(pass: ItemPass): string {
  return (
    `REMIT of this pass. Item kinds you may create: ${ALLOWED_KINDS[pass].join(', ')}. ` +
    `Link types you may use: ${ALLOWED_LINKS[pass].join(', ')}. ` +
    `Links point FROM the new item TO the other ("direction":"out"); only "${INBOUND_LINKS.join('", "')}" may use "direction":"in" ` +
    '(an existing claim assumes your new assumption). Anything outside this remit makes the WHOLE output be refused.'
  );
}
