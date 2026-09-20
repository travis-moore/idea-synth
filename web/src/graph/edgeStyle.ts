import type { RelationType } from '../../../src/domain/vocabulary';

/** Edge colour families used by the map and its legend. */
export type EdgeFamily = 'genealogy' | 'support' | 'conflict' | 'caveat' | 'tangent' | 'synthesis';

export const EDGE_FAMILY: Record<RelationType, EdgeFamily> = {
  derived_from: 'genealogy',
  branches_to: 'genealogy',
  supersedes: 'genealogy',
  merged_into: 'genealogy',
  answers: 'genealogy',
  tangent_of: 'tangent',
  synthesized_into: 'synthesis',
  supports: 'support',
  evidence_for: 'support',
  contradicts: 'conflict',
  evidence_against: 'conflict',
  qualifies: 'caveat',
  questions: 'caveat',
  corrects: 'caveat',
  assumes: 'caveat',
};

export const EDGE_FAMILIES: Record<EdgeFamily, { label: string; color: string; dashed: boolean }> =
  {
    genealogy: { label: 'Arose from / led to', color: 'var(--edge-genealogy)', dashed: false },
    support: { label: 'Supports · evidence for', color: 'var(--edge-support)', dashed: false },
    conflict: {
      label: 'Contradicts · evidence against',
      color: 'var(--edge-conflict)',
      dashed: false,
    },
    caveat: {
      label: 'Qualifies · questions · corrects · assumes',
      color: 'var(--edge-caveat)',
      dashed: false,
    },
    tangent: { label: 'Tangent of', color: 'var(--c-tangent)', dashed: true },
    synthesis: { label: 'Synthesised into', color: 'var(--c-synthesis)', dashed: false },
  };
