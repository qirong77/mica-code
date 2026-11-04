/**
 * 侧栏顶部的快捷筛选（漏斗点开才激活）。三档互斥：把它们做成可以叠加的条件，
 * 用户每换一次档都得重新读一遍「我现在到底筛的是什么」，而这一屏本来就是为了
 * 把几十条历史缩到一小撮。
 *
 * 「24 小时」是滚动窗口，不是本地日界：早上打开侧栏时「今天」几乎等于空列表，
 * 而用户想看的是「最近一天在动的那些」。
 *
 * 「进行中」合并两种状态——正在跑（绿点）与卡在等你做选择（橙点）。后者仍然是
 * 一轮没结束的会话，对用户来说都属于「还没完、可能要我看一眼」。
 */
export const SESSION_FILTER_MODES = [
  { id: 'all', label: '全部' },
  { id: '24h', label: '24 小时' },
  { id: 'active', label: '进行中' }
]

export const SESSION_FILTER_DAY_MS = 24 * 60 * 60 * 1000

/** 认不出的档位一律当「全部」：界面上的按钮和这里共用同一份 id。 */
export function sessionFilterMode(id) {
  return SESSION_FILTER_MODES.find((mode) => mode.id === id) ?? SESSION_FILTER_MODES[0]
}

/**
 * 一条会话是否落在这一档里。`stateOf` 必须由调用方传行首状态的唯一实现
 * （`session-state.js` 的 `liveSessionRowState`）——圆点亮着却筛不出来，
 * 是最难解释的那种 bug。
 */
export function matchesSessionFilter(session, modeId, { now = Date.now(), stateOf } = {}) {
  const mode = sessionFilterMode(modeId).id
  if (mode === 'all') return true
  if (mode === '24h') {
    const updatedAt = Number(session?.updatedAtMs)
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false
    return now - updatedAt <= SESSION_FILTER_DAY_MS
  }
  const state = stateOf ? stateOf(session) : session?.state
  return state === 'running' || state === 'awaiting'
}

export function filterSessions(sessions, modeId, options) {
  const list = Array.isArray(sessions) ? sessions : []
  if (sessionFilterMode(modeId).id === 'all') return list
  return list.filter((session) => matchesSessionFilter(session, modeId, options))
}
