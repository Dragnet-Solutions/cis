import type { ReactNode } from 'react';

export type PillKind = 'neutral' | 'ok' | 'warn' | 'stop' | 'info' | 'muted';

export function Pill({ kind, children }: { kind: PillKind; children: ReactNode }): JSX.Element {
  return <span className={`pill ${kind}`}>{children}</span>;
}
