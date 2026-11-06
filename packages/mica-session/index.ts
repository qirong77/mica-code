import { micaSessionStore } from './sessionStore.js';
import { listSessionTurnLocks } from './liveSessions.js';
import { readSessionWrites, recordSessionWrite } from './sessionWrites.js';

/** 会话持久化入口，负责保存、恢复、列出和删除 agent runtime 快照。 */
export const micaSession = {
  dir: micaSessionStore.dir,
  createStore: micaSessionStore.createStore,
  createId: micaSessionStore.createId,
  acquireTurnLease: micaSessionStore.acquireTurnLease,
  listTurnLocks: listSessionTurnLocks,
  recordWrite: recordSessionWrite,
  readWrites: readSessionWrites,
  SessionStore: micaSessionStore.SessionStore,
};

export { isProcessAlive, listRecentSessionFiles, listSessionTurnLocks, readFileHead } from './liveSessions.js';
export { readSessionWrites, recordSessionWrite, sessionWritesPath } from './sessionWrites.js';
// 保存后紧接着算内容签名时用：省掉一次整份序列化（见 sessionStore 里的说明）。
export { takeLastSerializedSession } from './sessionStore.js';

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

export type {
  ReadSessionWritesOptions,
  RecordSessionWriteOptions,
  SessionWriteRecord,
} from './sessionWrites.js';
