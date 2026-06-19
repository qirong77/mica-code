import { createSessionId, SessionStore } from './sessionStore.js';

export const micaSession = {
  createStore: () => new SessionStore(),
  createId: createSessionId,
};

export { createSessionId, SessionStore, SESSION_DIR } from './sessionStore.js';
export type { PersistedRuntimeSnapshot, PersistedSession, SessionStoreLike, SessionSummary } from './sessionStore.js';
