export function forkSessionSnapshot(session, id, now = new Date().toISOString()) {
  if (!session || typeof session !== 'object' || !session.snapshot) {
    throw new Error('Invalid session')
  }
  if (!id || typeof id !== 'string') throw new Error('Invalid fork session id')
  const title =
    typeof session.title === 'string' && session.title.trim() ? session.title.trim() : 'Chat'
  const snapshot = structuredClone(session.snapshot)
  // fork 继承对话与上下文，但不继承用量记账：新会话的 token 统计从空开始，否则同一条
  // 请求会同时算在来源会话与 fork 上。`lastUsage` 例外——它描述继承来的上下文占用，
  // 聊天状态栏的 ctx / tokens 需要它。
  snapshot.usageHistory = []
  snapshot.subagentUsageHistory = []
  return {
    ...session,
    id,
    title: `${title} (fork)`,
    titleSource: 'manual',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    turnState: 'completed',
    snapshot
  }
}
