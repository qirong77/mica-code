/**
 * 终端里跑的 mica 结束一轮时，运行时会按 PTY 记一条「有未读结果」
 * （terminalId 形如 `<终端条目 id>:<pane>`，见 host/notifyServer.js）。
 *
 * 未读属于**那一条 PTY**，不是「某条会话页签」：同一个条目下可以同时挂着多个 PTY，
 * 事件也只有产生它的那条 PTY 收得到。所以标记已读必须用回原始的 terminalId——按条目
 * 拼一个 `<条目 id>:mica` 只会打到一条不存在的终端上，未读永远清不掉（dock 徽标
 * 挂着不放就是这个原因）。归并成条目 id 的视图只给界面显示用。
 */

/** `rt-1:terminal` → `rt-1`；没有 pane 后缀时原样返回 */
export function terminalNodeId(terminalId) {
  if (typeof terminalId !== 'string' || !terminalId) return null
  const index = terminalId.lastIndexOf(':')
  if (index <= 0) return terminalId
  return terminalId.slice(0, index)
}

/** 界面状态里的那一条：只留显示与判定要用的字段 */
export function normalizeTerminalState(state) {
  return {
    unread: !!state?.unread,
    running: !!state?.running,
    processRunning: !!state?.processRunning,
    lastType: state?.lastType ?? null,
    lastEventAt: state?.lastEventAt ?? Date.now()
  }
}

/**
 * 按条目归并（侧栏行、终端标签、插件卡片读的都是这份）：
 * 运行中 / 有未读取并集，红点（`lastType === 'turn.error'`）与未读短闪的 key 取最近一次事件。
 */
export function collapseTerminalStates(terminalStates = {}) {
  const byNode = {}
  for (const [terminalId, state] of Object.entries(terminalStates || {})) {
    if (!state) continue
    const nodeId = terminalNodeId(terminalId)
    if (!nodeId) continue
    const current = byNode[nodeId]
    const eventAt = Number(state.lastEventAt) || 0
    if (!current) {
      byNode[nodeId] = normalizeTerminalState(state)
      continue
    }
    current.unread = current.unread || !!state.unread
    current.running = current.running || !!state.running
    current.processRunning = current.processRunning || !!state.processRunning
    if (eventAt >= (Number(current.lastEventAt) || 0)) {
      current.lastType = state.lastType ?? null
      current.lastEventAt = state.lastEventAt ?? null
    }
  }
  return byNode
}

/**
 * 一次「看过了」要清掉哪些 PTY：给的是 PTY id 就清它自己，给的是条目 id 就清它名下
 * 所有还没读过的 PTY。只列有未读的，省得对着一个已经清干净的条目反复发请求。
 */
export function unreadTerminalIds(terminalStates = {}, target) {
  if (!target || typeof target !== 'string') return []
  if (terminalStates?.[target]?.unread) return [target]
  const prefix = `${target}:`
  return Object.keys(terminalStates || {}).filter(
    (terminalId) => terminalId.startsWith(prefix) && terminalStates[terminalId]?.unread
  )
}
