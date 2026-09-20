import { USER_CREATABLE_KINDS } from '../../../src/domain/vocabulary';
import type { ItemKind } from '../../../src/domain/vocabulary';
import { KIND_LABELS } from '../labels';

interface KindSelectProps {
  value: ItemKind | undefined;
  onChange: (kind: ItemKind | undefined) => void;
  /** What the server does when no kind is sent. */
  defaultLabel: string;
  ariaLabel?: string;
}

function isUserCreatableKind(value: string): value is ItemKind {
  return USER_CREATABLE_KINDS.some((kind) => kind === value);
}

export function KindSelect({ value, onChange, defaultLabel, ariaLabel = 'Kind' }: KindSelectProps) {
  return (
    <select
      aria-label={ariaLabel}
      value={value ?? ''}
      onChange={(e) => onChange(isUserCreatableKind(e.target.value) ? e.target.value : undefined)}
    >
      <option value="">{defaultLabel}</option>
      {USER_CREATABLE_KINDS.map((kind) => (
        <option key={kind} value={kind}>
          {KIND_LABELS[kind]}
        </option>
      ))}
    </select>
  );
}
