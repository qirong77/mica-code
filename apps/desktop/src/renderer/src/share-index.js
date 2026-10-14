import { sessionShareUrl } from './app-url'

/**
 * 分享链接列表（分享端口根路径）的行投影：把运行时的分享登记与会话清单对成一行行可点的
 * 记录。纯函数，组件里不再算一遍（见 ShareIndex.jsx）。
 *
 * 登记表里只有会话 id 与分享时间，标题/工作目录都来自会话文件；会话被删掉之后登记还留着，
 * 所以「已不存在」是一等状态：如实标出来并允许移除，而不是悄悄消失。
 */
export function buildShareRows(entries, sessions, { baseUrl = null } = {}) {
  const byId = new Map()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session?.id) byId.set(session.id, session)
  }
  const rows = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : ''
    if (!sessionId) continue
    const session = byId.get(sessionId) || null
    rows.push({
      sessionId,
      title: session?.title || (session ? sessionId : '会话已不存在'),
      cwd: session?.cwd || '',
      updatedAtMs: Number(session?.updatedAtMs) || 0,
      sharedAt: Number(entry?.sharedAt) || 0,
      exists: Boolean(session),
      url: sessionShareUrl(baseUrl, sessionId)
    })
  }
  return rows.sort((a, b) => b.sharedAt - a.sharedAt || a.sessionId.localeCompare(b.sessionId))
}

/** 相对时间：刚刚 / 3m / 2h / 5d，超过一个月直接给日期。 */
export function shareRowTime(row, now = Date.now()) {
  const value = Number(row?.updatedAtMs) || 0
  if (!value) return ''
  const diff = Math.max(0, now - value)
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 30 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`
  return new Date(value).toLocaleDateString()
}
