import type { IdeaDto } from '../../../src/api-types';
import { api } from '../api';
import { useAction } from '../queries';
import { ErrorNote } from './Feedback';

interface SynthesizeControlProps {
  idea: IdeaDto;
  label: string;
  onDone: () => void;
}

/**
 * Runs Steps 6-8. When the review gate blocks, the server answers 409; the message is shown
 * and the user may knowingly override the gate ("Proceed anyway" re-posts with force).
 */
export function SynthesizeControl({ idea, label, onDone }: SynthesizeControlProps) {
  const synthesize = useAction((force: boolean) => api.synthesize(idea.id, force), onDone);
  const gateBlocked = synthesize.error?.status === 409;

  return (
    <div className="synthesize-control">
      <div className="form-actions">
        <button
          type="button"
          className={idea.gate.canProceed ? 'primary' : 'primary looks-disabled'}
          aria-describedby={idea.gate.canProceed ? undefined : 'gate-hint'}
          disabled={synthesize.isPending}
          onClick={() => synthesize.mutate(false)}
        >
          {synthesize.isPending ? 'Building synthesis…' : label}
        </button>
        {gateBlocked && (
          <button
            type="button"
            className="warn"
            disabled={synthesize.isPending}
            onClick={() => synthesize.mutate(true)}
          >
            Proceed anyway
          </button>
        )}
      </div>
      {!idea.gate.canProceed && !gateBlocked && (
        <p className="hint" id="gate-hint">
          The review gate is closed while items still need you. You can resolve them in the Review
          tab first.
        </p>
      )}
      <ErrorNote error={synthesize.error} />
      {gateBlocked && (
        <p className="hint">
          Proceeding overrides the review gate. Unresolved items will be carried into the synthesis
          as open questions, and the override is recorded in the history.
        </p>
      )}
    </div>
  );
}
