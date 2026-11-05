import { listSessionTurnLocks, type SessionTurnLock } from '@packages/mica-session/index.js';
import type { CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';

export type SessionPeerDeps = {
  services: CommandRuntimeServices;
  /** 运行中会话枚举；测试注入用，默认读 `$MICA_HOME/sessions/.turn-locks`。 */
  listTurnLocks?: () => SessionTurnLock[];
};

export type PeerSnapshot = {
  currentSessionId: string;
  running: SessionTurnLock[];
  stale: SessionTurnLock[];
  selfLock: SessionTurnLock | undefined;
  /**
   * 与本会话同一工作目录、且仍在跑的其它会话。
   *
   * 这一项是「工作区不是本会话独占」的唯一判据：`git status` 里看不到作者，能证明
   * 还有别的手在改同一批文件的，只有这些活着的租约。
   */
  sameCwd: SessionTurnLock[];
};

export function readPeerSnapshot(deps: SessionPeerDeps): PeerSnapshot {
  const currentSessionId = deps.services.getCurrentAgentSessionId?.() ?? '';
  const locks = (deps.listTurnLocks ?? listSessionTurnLocks)();
  const running = locks.filter((lock) => lock.alive);
  const stale = locks.filter((lock) => !lock.alive);
  const selfLock = running.find((lock) => Boolean(currentSessionId) && lock.sessionId === currentSessionId);
  const sameCwd = selfLock?.cwd
    ? running.filter((lock) => lock.sessionId !== selfLock.sessionId && lock.cwd === selfLock.cwd)
    : [];
  return { currentSessionId, running, stale, selfLock, sameCwd };
}

/** 给 prompt 段落用的一行摘要；`session_peers` 里有完整版，这里只留判据。 */
export function formatSameCwdPeer(lock: SessionTurnLock, now = Date.now()): string {
  const started = Date.parse(lock.startedAt);
  const elapsed = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  const minutes = Math.floor(elapsed / 60_000);
  const since = !Number.isFinite(started)
    ? '起步时间未知'
    : minutes < 1
      ? '本轮刚刚开始'
      : minutes < 60
        ? `本轮已跑 ${minutes} 分钟`
        : `本轮已跑 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  const title = lock.title?.trim() || '(标题未读到)';
  return `- ${lock.sessionId} · ${title} · ${since}`;
}
