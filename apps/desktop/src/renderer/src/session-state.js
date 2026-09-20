import { childGroups } from './session-projects'

/**
 * Sidebar activity is process-local. A persisted session snapshot may retain
 * turnState="running" after a crash, so it must never drive the live dot.
 *
 * The red dot is the one persisted signal the sidebar shows, and it is decided
 * host-side (`interrupted`: turnState is error, or running with nobody holding
 * the turn lease) so a session another process is actively running is never
 * labelled as unexpectedly terminated.
 *
 * `remoteRunning` is the same probe read the other way: a live turn lease means
 * another window (or another runtime/terminal on this machine) is writing the
 * session right now, so the row breathes green instead of looking idle.
 */
export function liveSessionRowState({ notificationState, interrupted, remoteRunning }) {
  if (notificationState?.running) return 'running'
  if (remoteRunning) return 'running'
  if (notificationState?.lastType === 'turn.error') return 'error'
  if (interrupted) return 'error'
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

/**
 * 输入框里还没发出去的文本存在运行时的界面状态里（ui-state 的 `drafts` 键），侧栏要
 * 指着那条会话说「你还有话没发」。标记按 chat 节点 id 记，会话行用它 openBySession 映射
 * 出来的节点查，草稿页签直接用节点 id 查。
 *
 * 与 running/unread 那类 turn 状态无关，也不参与折叠容器的状态合并：它和红灯一样
 * 属于单个会话自己的编辑态，挂在容器上指不出是哪一条有没发出去的文本。
 *
 * 每次按键都会重算（草稿表变了），成员没变时必须交回原来的 Set 引用，否则整个会话树
 * 会跟着每一次输入重渲染。
 */
export function draftMarkers(drafts, previous = new Set()) {
  const next = new Set()
  for (const [nodeId, text] of Object.entries(drafts || {})) {
    // 空白文本不算未发送内容（输入几个空格就亮图标没有意义）
    if (nodeId && String(text ?? '').trim()) next.add(nodeId)
  }
  if (previous.size === next.size) {
    let same = true
    for (const nodeId of next) {
      if (!previous.has(nodeId)) {
        same = false
        break
      }
    }
    if (same) return previous
  }
  return next
}

/**
 * 折叠起来的分组/分区会把里面的行从侧栏藏掉，那一层必须替它显示状态，否则
 * 「正在跑」和「有未读」在折叠状态下完全不可见。合并优先级与 RowLeading 的
 * 显示分支同源：运行中 > 未读。
 *
 * 异常中断（error）刻意不参与合并：它是单个会话自己的状态——用户点进去才需要
 * 关心是哪一条没跑完，而折叠容器上挂一个红灯只会指不出对象、还让「展开找红灯」
 * 变成必然操作。所以 error 只留在会话行自身（liveSessionRowState），不上浮。
 */
const ROW_STATE_RANK = { running: 2, unread: 1 }

export function mergeRowStates(states = []) {
  let best = null
  let rank = 0
  for (const state of states) {
    const current = ROW_STATE_RANK[state] || 0
    if (current > rank) {
      rank = current
      best = state
    }
  }
  return best
}

/**
 * groupId -> 该分组子树（含自己、含后代分组）里所有会话与草稿的合并状态。
 * 传进来的必须是渲染时用的同一份归属数据，这样「代显的状态」与「折叠后真正
 * 看不见的行」才不会分叉。
 */
export function collectGroupStates({
  projects,
  sessionsByGroup,
  draftsByGroup,
  stateOfSession,
  stateOfDraft
}) {
  const states = new Map()
  const walk = (group) => {
    const collected = []
    for (const session of sessionsByGroup?.get(group.id) || []) {
      collected.push(stateOfSession(session))
    }
    for (const draft of draftsByGroup?.get(group.id) || []) {
      collected.push(stateOfDraft(draft))
    }
    for (const child of childGroups(projects, group.id)) collected.push(walk(child))
    const state = mergeRowStates(collected)
    states.set(group.id, state)
    return state
  }
  for (const group of childGroups(projects, null)) walk(group)
  return states
}
