/**
 * Sidebar activity is process-local. A persisted session snapshot may retain
 * turnState="running" after a crash, so it must never drive the live dot.
 */
export function liveSessionRowState({ notificationState }) {
  if (notificationState?.running) return 'running'
  if (notificationState?.unread) return 'unread'
  return null
}

/**
 * 右侧面板终端不在工作区 nodes 里，只能靠创建时记下的 sessionId 归属回会话行
 * （notify 状态按 PTY id `<nodeId>:<pane>` 保存，用终端条目自己的 id 取即可）。
 * 只认 processRunning：那是「终端里有长驻前台进程」的信号，Mica turn 已由
 * 标题的呼吸动画表达，不能混进来。
 */
export function runningTerminalSessions(rightTerms = [], states = {}) {
  const ids = new Set()
  for (const term of rightTerms || []) {
    if (term?.sessionId && states?.[term.id]?.processRunning) ids.add(term.sessionId)
  }
  return ids
}

/**
 * Inbox only lists finished work the user has not reviewed yet: a running turn
 * has no result to look at, so it stays out of the list (the session tree row
 * already shows its running dot).
 */
export function buildInboxItems({
  sessions = [],
  draftTabs = [],
  openBySession = {},
  unread = {}
}) {
  const items = []
  for (const session of sessions) {
    const nodeId = openBySession[session.id]
    const state = nodeId ? unread[nodeId] : null
    if (state?.unread) items.push({ key: nodeId, nodeId, session, state })
  }
  for (const draft of draftTabs) {
    const state = unread[draft.id]
    if (state?.unread) items.push({ key: draft.id, nodeId: draft.id, draft, state })
  }
  return items.sort((a, b) => (b.state.lastEventAt || 0) - (a.state.lastEventAt || 0))
}
