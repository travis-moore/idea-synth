import type { ReactNode } from 'react';

/** Inline, non-blocking error message. Renders nothing when there is no error. */
export function ErrorNote({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return (
    <p className="error-note" role="alert">
      {error.message}
    </p>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted loading">{label}</p>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children && <div className="empty-state-body">{children}</div>}
    </div>
  );
}
