/**
 * 侧栏顶部的快捷筛选（漏斗点开才激活）。几档互斥：把它们做成可以叠加的条件，
 * 用户每换一次档都得重新读一遍「我现在到底筛的是什么」，而这一屏本来就是为了
 * 把几十条历史缩到一小撮。
 *
 * 每一档都是**滚动窗口**，不是本地日界：早上打开侧栏时「今天」几乎等于空列表，
 * 而用户想看的是「最近这几个小时在动的那些」。档位只有这么多——侧栏就 260px，
 * 再多档按钮只能换行或缩成一团（行本身的排布见 `SessionTree` 的筛选行）。
 */
export const SESSION_FILTER_HOUR_MS = 60 * 60 * 1000

export const SESSION_FILTER_MODES = [
  { id: 'all', label: '全部', hours: 0 },
  { id: '4h', label: '4 小时', hours: 4 },
  { id: '8h', label: '8 小时', hours: 8 },
  { id: '12h', label: '12 小时', hours: 12 },
  { id: '24h', label: '24 小时', hours: 24 }
]

/** 认不出的档位一律当「全部」：界面上的按钮和这里共用同一份 id。 */
export function sessionFilterMode(id) {
  return SESSION_FILTER_MODES.find((mode) => mode.id === id) ?? SESSION_FILTER_MODES[0]
}

/**
 * 一条会话是否落在这一档里：`hours` 为 0（全部）时谁都在里面，其余只看最近一次
 * 更新时间是否落在那个滚动窗口内。时间戳缺失 / 非法一律不算最近——宁可漏掉一条
 * 也不要把半年前的会话顶进「4 小时」。
 */
export function matchesSessionFilter(session, modeId, { now = Date.now() } = {}) {
  const { hours } = sessionFilterMode(modeId)
  if (!hours) return true
  const updatedAt = Number(session?.updatedAtMs)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false
  return now - updatedAt <= hours * SESSION_FILTER_HOUR_MS
}

export function filterSessions(sessions, modeId, options) {
  const list = Array.isArray(sessions) ? sessions : []
  if (!sessionFilterMode(modeId).hours) return list
  return list.filter((session) => matchesSessionFilter(session, modeId, options))
}
