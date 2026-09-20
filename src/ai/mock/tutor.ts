/**
 * Mock guided-reasoning tutor. Scripted for the "robots" example; template-driven for
 * anything else. Adequacy is judged by simple, documented heuristics.
 */
import type { ScaffoldLevel } from '../../domain/scaffolding';
import type { ItemKind } from '../../domain/vocabulary';
import type { TutorAssessInput, TutorMoveInput } from '../passes';
import type { TutorAssessOutput, TutorMoveOutput } from '../schemas';

interface ScriptedQuestion {
  /** Level 1: the open question. */
  open: string;
  /** Level 2: narrowed. */
  narrowed: string;
  /** Level 3: structure, plus any background the user may be missing. */
  structure: string;
  teaching?: string;
  /** Level 4. */
  options: string[];
  /** Level 5. */
  premise: { text: string; kind: ItemKind };
}

const ROBOTS: ScriptedQuestion[] = [
  {
    open: 'What would have to be true for that to happen?',
    narrowed:
      'If nobody needed to work, robots would presumably have to do the work people do now. Can robots already do every job humans do?',
    structure:
      'One way to break it down: (a) capability - can robots do the task at all; (b) cost - is it cheaper than paying a person; (c) distribution - how do people without jobs get what the robots make. Which of these looks like the biggest obstacle to you?',
    teaching:
      'Background: robots are currently strongest at repetitive tasks in controlled settings such as factories, and weakest at varied physical work in messy settings and at work that depends on trust between people.',
    options: [
      'Robots would need to be able to do every necessary task.',
      'Robots would need to be cheaper than human workers.',
      'People would need a way to get income or goods without a job.',
    ],
    premise: {
      text: 'For nobody to have to work, robots must be able to do essentially all necessary work more cheaply than people, AND people without jobs must still have a way to obtain what the robots produce.',
      kind: 'assumption',
    },
  },
  {
    open: 'Can you think of a job robots cannot currently do? What prevents them from doing it?',
    narrowed:
      'Think of a plumber fixing a leak in an old house, or a nurse calming a frightened patient. What makes those hard for a robot?',
    structure:
      'Jobs can be hard for robots for different reasons: unpredictable physical environments, fine dexterity, social trust, or responsibility when things go wrong. Pick one job and say which reason applies.',
    options: [
      'Unpredictable environments (every house is different).',
      'Dexterity and touch.',
      'Human trust and care.',
      'Someone has to be accountable.',
    ],
    premise: {
      text: 'Some jobs resist automation because they combine unpredictable environments, fine dexterity and human trust; progress on one of these does not automatically solve the others.',
      kind: 'factual_claim',
    },
  },
  {
    open: 'Suppose robots could do every job. Does it follow that nobody has to work? Who would own the robots?',
    narrowed:
      'If a few companies owned all the robots, how would everyone else pay for what the robots make?',
    structure:
      'Separate two questions: production (can everything be made without human labour?) and distribution (who gets it?). Your hypothesis needs both. Which one does "robots" solve?',
    options: [
      'Owners keep the gains; most people still need some income.',
      'Governments tax robot output and pay everyone a basic income.',
      'Goods become so cheap that little income is needed.',
    ],
    premise: {
      text: 'Automation solves production, not distribution: whether people "have to work" depends on how access to what robots produce is arranged, which is a political and economic choice.',
      kind: 'inference',
    },
  },
  {
    open: 'Is "not having to work" the same as "not working"? What might people still choose to do?',
    narrowed:
      'People who retire or win the lottery often keep working on something. Why might that be?',
    structure:
      'Work gives people income, but also structure, status, meaning and company. Which of those could robots replace, and which could they not?',
    options: [
      'Income only.',
      'Meaning and purpose.',
      'Status and recognition.',
      'Company and routine.',
    ],
    premise: {
      text: 'Work provides meaning, status and social contact as well as income, so even if robots removed the need to work, many people would probably still choose some form of it.',
      kind: 'hypothesis',
    },
  },
];

function genericScript(hypothesis: string): ScriptedQuestion[] {
  const h = hypothesis.trim().replace(/[.?!]+$/, '');
  return [
    {
      open: `What would have to be true for this to hold: "${h}"?`,
      narrowed:
        'Name one specific condition that must hold. What is the first thing that comes to mind?',
      structure:
        'Try splitting it into: what must be possible, what must be affordable or practical, and who must go along with it.',
      options: [
        'Something must be possible that is not possible yet.',
        'It must be practical or affordable.',
        'Other people or institutions must go along with it.',
      ],
      premise: {
        text: `[mock] A live model would supply a candidate premise for "${h}" here. Treat this placeholder as: "at least one enabling condition is not yet met".`,
        kind: 'assumption',
      },
    },
    {
      open: 'What is the strongest reason someone might doubt it?',
      narrowed:
        'Imagine a thoughtful friend who disagrees. What is the first thing they would say?',
      structure:
        'Doubts usually attack either the facts, the cause-and-effect step, or the values. Which is weakest here?',
      options: [
        'The facts might be wrong.',
        'The cause-and-effect step might not hold.',
        'People might not want the outcome.',
      ],
      premise: {
        text: '[mock] A likely objection is that the cause-and-effect step is assumed rather than shown.',
        kind: 'objection',
      },
    },
    {
      open: 'What could you observe that would change your mind?',
      narrowed: 'Describe one result, event or example that would make you give the idea up.',
      structure:
        'A good test names something that would happen if you are right and would not happen if you are wrong.',
      options: ['A counterexample.', 'A failed prediction.', 'An expert consensus against it.'],
      premise: {
        text: '[mock] If no observation could change your mind, the idea may be unfalsifiable as stated and needs sharpening.',
        kind: 'inference',
      },
    },
  ];
}

export const scriptFor = (hypothesis: string) =>
  /robot/i.test(hypothesis) ? ROBOTS : genericScript(hypothesis);

const STUCK =
  /^\s*(i\s+)?(really\s+)?(don'?t|do\s+not|dunno|no\s+idea|not\s+sure|idk|unsure|\?+)\b/i;

/**
 * Mock adequacy heuristic:
 * - "I don't know"-style answers             -> stuck
 * - one or two words to an OPEN (L1) question -> partial (a reason is missing)
 * - anything else                             -> advances
 */
export function mockAssess(input: TutorAssessInput): TutorAssessOutput {
  const answer = input.answer.trim();
  const words = answer.split(/\s+/).filter(Boolean).length;
  if (STUCK.test(answer) || words === 0)
    return {
      adequacy: 'stuck',
      explanation:
        "That's fine: not knowing is a normal place to be. I'll give a bit more help rather than repeat the question.",
    };
  if (words <= 2 && input.level === 1)
    return {
      adequacy: 'partial',
      explanation:
        'That gives a position but not a reason. An answer that moves things forward would say *why* you think so, or give one example.',
      answer_kind: 'factual_claim',
    };
  return {
    adequacy: 'advances',
    explanation: 'That gives us something concrete to build on.',
    answer_kind: /\b(should|ought|fair|good|bad)\b/i.test(answer)
      ? 'value_judgment'
      : /\b(because|so|therefore|means)\b/i.test(answer)
        ? 'inference'
        : 'factual_claim',
  };
}

export function mockMove(input: TutorMoveInput): TutorMoveOutput {
  const script = scriptFor(input.hypothesis);
  const q = script[input.questionIndex];
  if (!q)
    return {
      question:
        'You have worked through the main questions. The reasoning tree you built can now enter the synthesis workflow.',
      done: true,
    };
  const level: ScaffoldLevel = input.level;
  switch (level) {
    case 1:
      return { question: q.open, done: false };
    case 2:
      return { question: q.narrowed, done: false };
    case 3:
      return { question: q.structure, teaching: q.teaching, done: false };
    case 4:
      return {
        question: 'Here are some possibilities. Which seem right to you, and why?',
        options: q.options,
        done: false,
      };
    case 5:
      return {
        question:
          'Here is a likely answer from me. Do you accept it, reject it, or want to change it?',
        supplied_premise: q.premise,
        done: false,
      };
  }
}
