/**
 * 「最近目录」的收集、筛选与排序（纯逻辑，便于单测）。
 *
 * 目录清单来自会话记录：每个会话都带着 cwd，按最近使用时间排一遍就是最自然的「最近目录」，
 * 不需要另外记账。面板里的搜索只在这份清单上过滤 + 重排，**不查文件系统**——用户要找的是
 * 自己用过的目录，去扫盘既慢又会把无关目录塞进来。
 */

/** 面板里最多准备多少条：会话里出现过的目录可能上百个，收进这里、靠搜索收敛即可。 */
export const MAX_RECENT_CWDS = 60

/** 目录路径归一：去掉首尾空白与末尾斜杠（根目录除外），同一个目录不要出现两条。 */
export function normalizeCwd(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const stripped = trimmed.replace(/[\\/]+$/, '')
  return stripped || trimmed
}

/** 会话列表 → 最近目录条目（去重，按最近使用时间倒序）。 */
export function collectRecentCwds(sessions, { limit = MAX_RECENT_CWDS } = {}) {
  const map = new Map()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const path = normalizeCwd(session?.cwd)
    if (!path) continue
    const usedAtMs = Number(session?.updatedAtMs) || 0
    const previous = map.get(path)
    if (previous) {
      previous.usedAtMs = Math.max(previous.usedAtMs, usedAtMs)
      previous.sessionCount += 1
      continue
    }
    map.set(path, { path, usedAtMs, sessionCount: 1 })
  }
  return [...map.values()]
    .sort((a, b) => b.usedAtMs - a.usedAtMs || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, limit))
}

/** 查询串 → 小写词元。多段查询（`mica desktop`）按「每段都要命中路径」理解。 */
export function cwdQueryTokens(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

export function matchesCwdQuery(path, tokens) {
  if (!tokens || tokens.length === 0) return true
  const haystack = String(path ?? '').toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/** 路径末段（项目名）。末段总在行尾完整显示，路径过长时只截断前面那截。 */
export function splitCwd(path) {
  const value = String(path ?? '')
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (index < 0) return { head: '', tail: value }
  return { head: value.slice(0, index + 1), tail: value.slice(index + 1) }
}

/** 末段命中档位：数字越小越靠前。项目名整体命中比只在路径别处命中更可能是想要的。 */
export function cwdMatchRank(path, token) {
  const tail = splitCwd(path).tail.toLowerCase()
  if (tail === token) return 0
  if (tail.startsWith(token)) return 1
  if (tail.includes(token)) return 2
  return 3
}

/**
 * 过滤 + 重排。查询为空时保持「最近使用」的原顺序；有查询时先按末段命中档位，再按路径短的
 * 优先，然后才是最近使用——同名项目在浅目录里的那个通常才是用户要的。
 */
export function rankCwdMatches(entries, query, { limit = MAX_RECENT_CWDS } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const capped = Math.max(0, limit)
  const tokens = cwdQueryTokens(query)
  if (tokens.length === 0) return list.slice(0, capped)
  const scored = []
  for (const entry of list) {
    const path = String(entry?.path ?? '')
    if (!matchesCwdQuery(path, tokens)) continue
    // 取所有词里最好的一档：多词查询（`mica desktop`）里只要有一词命中项目名，
    // 就说明这个词指的就是这个目录，不该被另一个只在路径中段命中的词压下去。
    let rank = 3
    for (const token of tokens) rank = Math.min(rank, cwdMatchRank(path, token))
    scored.push({ entry, rank })
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.entry.path.length - b.entry.path.length ||
      (b.entry.usedAtMs || 0) - (a.entry.usedAtMs || 0) ||
      a.entry.path.localeCompare(b.entry.path)
  )
  return scored.slice(0, capped).map((item) => item.entry)
}
