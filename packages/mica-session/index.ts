import { micaSessionStore } from './sessionStore.js';

/** 会话持久化入口，负责保存、恢复、列出和删除 agent runtime 快照。 */
export const micaSession = micaSessionStore;

export type { PersistedRuntimeSnapshot, PersistedSession, SessionStoreLike, SessionSummary } from './sessionStore.js';
