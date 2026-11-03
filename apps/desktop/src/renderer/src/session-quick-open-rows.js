/**
 * ⌘P 快速打开会话（VS Code quick open 的会话版）的结果组装，纯逻辑。
 *
 * 匹配规则与侧栏搜索共用 `@packages/mica-web-shared/session-search`：同一个词在
 * 侧栏命中、在这里不命中会让人以为功能坏了。区别只在范围——这里**不搜对话正文**
 * （正文要读会话文件，快速打开必须即时响应），也不按时间范围过滤，空查询时按最近
 * 更新排。
 */
import {
  foldSearchText,
  matchRanges,
  scoreSessionSearch,
  tokenizeSearchQuery
} from '@packages/mica-web-shared/session-search.js'

/** 一次最多列这么多条：再多只能靠继续输入收窄，列出来也翻不动。 */
export const SESSION_QUICK_OPEN_LIMIT = 50

function baseName(path) {
  const trimmed = String(path || '').replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

function rangesOf(value, tokens) {
  if (!value || !tokens.length) return []
  return matchRanges(foldSearchText(value), tokens)
}

function itemOf(session, { tokens, groupName, score }) {
  const title = session.title || session.id
  const cwd = session.cwd || ''
  return {
    id: session.id,
    session,
    title,
    titleRanges: rangesOf(title, tokens),
    cwd,
    cwdRanges: rangesOf(cwd, tokens),
    cwdLabel: baseName(cwd),
    groupName: groupName || '',
    score,
    updatedAtMs: Number(session.updatedAtMs) || 0
  }
}

/**
 * @returns `{ items, total, tokens }`；`total` 是命中总数，`items` 已被截到 `limit`。
 */
export function buildSessionQuickOpenItems({
  sessions,
  query,
  groupNameOf = () => '',
  limit = SESSION_QUICK_OPEN_LIMIT
}) {
  const tokens = tokenizeSearchQuery(query)
  const list = (Array.isArray(sessions) ? sessions : []).filter((session) => session?.id)
  const recentFirst = (a, b) => (Number(b.updatedAtMs) || 0) - (Number(a.updatedAtMs) || 0)

  if (!tokens.length) {
    const ordered = [...list].sort(recentFirst)
    return {
      tokens,
      total: ordered.length,
      items: ordered
        .slice(0, limit)
        .map((session) => itemOf(session, { tokens, groupName: groupNameOf(session.id), score: 0 }))
    }
  }

  const hits = []
  for (const session of list) {
    const groupName = groupNameOf(session.id)
    const score = scoreSessionSearch(
      {
        title: session.title || session.id,
        cwd: session.cwd,
        id: session.id,
        extras: [groupName]
      },
      tokens
    )
    if (score < 0) continue
    hits.push({ session, groupName, score })
  }
  // 相关度优先，其次最近更新——搜索的第一诉求是「最像的排最前」。
  hits.sort((a, b) => b.score - a.score || recentFirst(a.session, b.session))
  return {
    tokens,
    total: hits.length,
    items: hits
      .slice(0, limit)
      .map((hit) => itemOf(hit.session, { tokens, groupName: hit.groupName, score: hit.score }))
  }
}
