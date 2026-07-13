import { micaSessionStore } from './sessionStore.js';

/** 会话持久化入口，负责保存、恢复、列出和删除 agent runtime 快照。 */
export const micaSession = {
  dir: micaSessionStore.dir,
  createStore: micaSessionStore.createStore,
  createId: micaSessionStore.createId,
  SessionStore: micaSessionStore.SessionStore,
};

export type {
  PersistedRuntimeSnapshot,
  PersistedSession,
  PersistedSessionTurnState,
  SessionStoreLike,
  SessionSummary,
} from './sessionStore.js';
