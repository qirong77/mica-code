import { micaSessionStore } from './sessionStore.js';
import { listSessionTurnLocks } from './liveSessions.js';

/** 会话持久化入口，负责保存、恢复、列出和删除 agent runtime 快照。 */
export const micaSession = {
  dir: micaSessionStore.dir,
  createStore: micaSessionStore.createStore,
  createId: micaSessionStore.createId,
  acquireTurnLease: micaSessionStore.acquireTurnLease,
  listTurnLocks: listSessionTurnLocks,
  SessionStore: micaSessionStore.SessionStore,
};

export { isProcessAlive, listRecentSessionFiles, listSessionTurnLocks, readFileHead } from './liveSessions.js';

export type {
  PersistedRuntimeSnapshot,
  PersistedSnapshotDisplayUsage,
  PersistedSession,
  PersistedSessionTurnState,
  SessionStoreLike,
  SessionSummary,
  SessionTurnLease,
} from './sessionStore.js';

export type {
  ListRecentSessionsOptions,
  ListSessionTurnLocksOptions,
  RecentSessionFile,
  SessionTurnLock,
} from './liveSessions.js';
