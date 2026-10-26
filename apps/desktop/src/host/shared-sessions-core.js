/**
 * 「分享链接」登记表的纯逻辑（不依赖 electron，便于单测；宿主在 shared-sessions.js）。
 *
 * `/share` 的根路径要列出一张分享链接的列表，而分享出去的界面本身不画左侧会话列表——
 * 所以「哪些会话被分享过」必须是运行时记着的一份数据，不能靠会话清单推。
 * 记录只有两件事：会话 id 与分享时间（标题/工作目录都在会话文件里，读的时候再对上）。
 *
 * 它**不是**权限：登记只是「这条链接出现在列表里」，任何人拿到 `?session=<id>` 都能打开
 * 那条会话（运行时无账号体系），取消登记同理不会让链接失效。
 */

export const SHARED_SESSIONS_VERSION = 1
/** 列表上限：分享是给人看的清单，攒到几百条之后已经没有意义。 */
export const MAX_SHARED_SESSIONS = 200

/** 与 packages/mica-session 的会话名校验同形，避免把奇怪的字符串写进列表/URL。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isValidSharedSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)
}

export function emptySharedSessions() {
  return { version: SHARED_SESSIONS_VERSION, entries: [] }
}

function normalizeEntry(entry) {
  const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId.trim() : ''
  if (!isValidSharedSessionId(sessionId)) return null
  const sharedAt = Number(entry?.sharedAt)
  return { sessionId, sharedAt: Number.isFinite(sharedAt) && sharedAt > 0 ? sharedAt : 0 }
}

/** 缺失、损坏、含非法条目的输入一律收敛成合法状态（保留能认出来的那些条目）。 */
export function normalizeSharedSessions(raw) {
  const list = Array.isArray(raw?.entries) ? raw.entries : []
  const byId = new Map()
  for (const entry of list) {
    const normalized = normalizeEntry(entry)
    if (!normalized) continue
    const previous = byId.get(normalized.sessionId)
    // 同一条会话重复出现时保留最近一次分享
    if (!previous || normalized.sharedAt > previous.sharedAt)
      byId.set(normalized.sessionId, normalized)
  }
  const entries = [...byId.values()].sort((a, b) => b.sharedAt - a.sharedAt)
  return { version: SHARED_SESSIONS_VERSION, entries: entries.slice(0, MAX_SHARED_SESSIONS) }
}

export function findSharedSession(state, sessionId) {
  return (
    normalizeSharedSessions(state).entries.find((entry) => entry.sessionId === sessionId) || null
  )
}

/**
 * 登记一条分享。已经登记过就只把时间刷新成这一次（列表按最近分享排序），于是重复点
 * 「分享链接」不会攒出重复条目。
 */
export function addSharedSession(state, sessionId, at = Date.now()) {
  if (!isValidSharedSessionId(sessionId)) return { ok: false, error: '无效的会话 id' }
  const sharedAt = Number(at) > 0 ? Number(at) : Date.now()
  const rest = normalizeSharedSessions(state).entries.filter(
    (entry) => entry.sessionId !== sessionId
  )
  const entries = [{ sessionId, sharedAt }, ...rest].slice(0, MAX_SHARED_SESSIONS)
  return { ok: true, state: { version: SHARED_SESSIONS_VERSION, entries } }
}

export function removeSharedSession(state, sessionId) {
  const current = normalizeSharedSessions(state)
  const entries = current.entries.filter((entry) => entry.sessionId !== sessionId)
  if (entries.length === current.entries.length) return { ok: false, state: current }
  return { ok: true, state: { version: SHARED_SESSIONS_VERSION, entries } }
}
