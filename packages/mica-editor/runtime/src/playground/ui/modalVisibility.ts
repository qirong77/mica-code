/** Share only modal visibility with the iframe host, never modal contents. */
const modals = new Set<symbol>();
const listeners = new Set<(open: boolean) => void>();

function publish() {
  for (const listener of listeners) listener(modals.size > 0);
}

export function registerEditorModal(): () => void {
  const id = Symbol();
  modals.add(id);
  if (modals.size === 1) publish();
  return () => {
    if (modals.delete(id) && modals.size === 0) publish();
  };
}

export function subscribeEditorModals(listener: (open: boolean) => void): () => void {
  listeners.add(listener);
  listener(modals.size > 0);
  return () => { listeners.delete(listener); };
}
