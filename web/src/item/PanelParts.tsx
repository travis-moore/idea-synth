import type { ReactNode } from 'react';
import type { ItemDto } from '../../../src/api-types';

export type ItemLookup = ReadonlyMap<string, ItemDto>;

export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function Collapsible({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="panel-section collapsible">
      <summary>{title}</summary>
      {children}
    </details>
  );
}
