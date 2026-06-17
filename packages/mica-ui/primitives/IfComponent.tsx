import React, { type ReactNode } from 'react';

export function IfComponent({ condition, children }: { condition: boolean; children: ReactNode }) {
  if (!condition) return null;
  return <>{children}</>;
}
