import type { IdeaStage } from '../../../src/domain/vocabulary';

type StepState = 'done' | 'active' | 'pending';

interface Step {
  label: string;
  number: number | null;
  who: 'user' | 'agent';
}

const STEPS: readonly Step[] = [
  { number: 1, label: 'Capture', who: 'user' },
  { number: 2, label: 'Extract', who: 'agent' },
  { number: 3, label: 'Explore', who: 'agent' },
  { number: 4, label: 'Fact-check', who: 'agent' },
  { number: 5, label: 'Skeptic', who: 'agent' },
  { number: null, label: 'Your review', who: 'user' },
  { number: 6, label: 'Builder', who: 'agent' },
  { number: 7, label: 'Synthesis', who: 'agent' },
  { number: 8, label: 'Tangents', who: 'agent' },
];

const REVIEW_INDEX = 5;

function stateOf(index: number, stage: IdeaStage): StepState {
  switch (stage) {
    case 'guided':
      return index === 0 ? 'active' : 'pending';
    case 'captured':
      return index === 0 ? 'done' : 'pending';
    case 'in_review':
      if (index < REVIEW_INDEX) return 'done';
      return index === REVIEW_INDEX ? 'active' : 'pending';
    case 'synthesized':
      return 'done';
  }
}

/** The eight-step workflow plus the human review gate, derived from the idea's stage. */
export function Stepper({ stage }: { stage: IdeaStage }) {
  return (
    <ol className="stepper" aria-label="Workflow progress">
      {STEPS.map((step, index) => {
        const state = stateOf(index, stage);
        const who = step.who === 'user' ? 'You' : 'AI';
        return (
          <li
            key={step.label}
            className={`step step-${state} step-${step.who}${step.number === null ? ' step-gate' : ''}`}
            title={`${step.label} — done by ${who === 'You' ? 'you' : 'the AI'} (${state})`}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            {step.number !== null && <span className="step-number">{step.number}</span>}
            <span className="step-label">{step.label}</span>
            <span className="step-who">{who}</span>
          </li>
        );
      })}
    </ol>
  );
}
