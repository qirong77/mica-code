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
 * 行首的呼吸绿点表达，不能混进来。
 */
export function runningTerminalSessions(rightTerms = [], states = {}) {
  const ids = new Set()
  for (const term of rightTerms || []) {
    if (term?.sessionId && states?.[term.id]?.processRunning) ids.add(term.sessionId)
  }
  return ids
}
