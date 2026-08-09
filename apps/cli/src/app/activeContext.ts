let activeContext: unknown | null = null;

export function setActiveContext<TContext>(context: TContext | null): void {
  activeContext = context;
}

export function getActiveContext<TContext>(): TContext | null {
  return activeContext as TContext | null;
}

export function clearActiveContext<TContext>(context: TContext): void {
  if (activeContext === context) {
    activeContext = null;
  }
}
