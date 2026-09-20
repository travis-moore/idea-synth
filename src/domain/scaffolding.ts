/**
 * Adaptive scaffolding for Guided Idea Development.
 *
 * The *level policy* lives here, in plain code, rather than inside a model prompt, so
 * that how much help the user gets is inspectable, deterministic and testable. The
 * model is asked to produce a move *at* a level; it does not choose the level.
 */
import { z } from 'zod';

export const SCAFFOLD_LEVELS = {
  1: { name: 'Open question', description: 'Ask an open question.' },
  2: {
    name: 'Narrowed question',
    description: 'Narrow the question or name the relevant dimension.',
  },
  3: {
    name: 'Structure',
    description:
      'Offer a structure, analogy, distinction or partial premise, teaching background if needed.',
  },
  4: {
    name: 'Options',
    description: 'Offer several possibilities and ask the user to evaluate them.',
  },
  5: {
    name: 'Supplied answer',
    description:
      'Give a likely answer, explicitly labelled as agent-supplied, and ask whether the user accepts it.',
  },
} as const;
export type ScaffoldLevel = 1 | 2 | 3 | 4 | 5;
export const MAX_LEVEL: ScaffoldLevel = 5;

/** How far the user's last answer moved the reasoning along. */
export const ADEQUACIES = ['advances', 'partial', 'stuck', 'off_track'] as const;
export type Adequacy = (typeof ADEQUACIES)[number];
export const adequacySchema = z.enum(ADEQUACIES);

/** What the user can do with a premise the agent supplied at level 5. */
export const PREMISE_STANCES = ['accept', 'reject', 'modify'] as const;
export type PremiseStance = (typeof PREMISE_STANCES)[number];

export interface LevelInput {
  level: ScaffoldLevel;
  adequacy: Adequacy;
  /** How many answers in a row, on this question, were already judged `partial`. */
  priorPartials: number;
}

export interface LevelDecision {
  level: ScaffoldLevel;
  /** True when the current question is done and the tutor should move to a new one. */
  advanceQuestion: boolean;
}

const clamp = (n: number): ScaffoldLevel => Math.min(MAX_LEVEL, Math.max(1, n)) as ScaffoldLevel;

/**
 * - `advances`  -> the user got there: next question, back to the least help.
 * - `partial`   -> stay once (with an explanation of what is missing), then add help.
 * - `stuck` / `off_track` -> add help. Never loop forever: level 5 supplies an answer.
 */
export function nextScaffoldLevel(input: LevelInput): LevelDecision {
  switch (input.adequacy) {
    case 'advances':
      return { level: 1, advanceQuestion: true };
    case 'partial':
      return {
        level: input.priorPartials >= 1 ? clamp(input.level + 1) : input.level,
        advanceQuestion: false,
      };
    case 'stuck':
    case 'off_track':
      return { level: clamp(input.level + 1), advanceQuestion: false };
  }
}
