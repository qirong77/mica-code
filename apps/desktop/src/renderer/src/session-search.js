/**
 * 侧栏搜索结果的组装（纯逻辑）。
 *
 * 分工：运行时的 `stats:search-sessions` 只负责「对话正文里有没有这些词」并给回一段片段
 * （见 apps/desktop/src/host/stats.js），标题/目录/分组名这些渲染层本来就有的字段在这里
 * 匹配，相关度与时间范围也在这里定。两边的匹配规则与打分共用
 * `@packages/mica-web-shared/session-search`——各写一份就会出现「同一个词一边命中一边
 * 不命中」，而结果又是拼在一起展示的。
 */
import {
  DEFAULT_SESSION_SEARCH_RANGE,
  SESSION_SEARCH_RANGES,
  foldSearchText,
  matchRanges,
  scoreSessionSearch,
  sessionSearchRange,
  sessionSearchSinceMs,
  tokenizeSearchQuery
} from '@packages/mica-web-shared/session-search.js'

export {
  DEFAULT_SESSION_SEARCH_RANGE,
  SESSION_SEARCH_RANGES,
  sessionSearchRange,
  sessionSearchSinceMs,
  tokenizeSearchQuery
}

/** 结果条数上限：侧栏是扫读的地方，再多也没人会往下翻。 */
export const SESSION_SEARCH_RESULT_LIMIT = 200

/** 运行时返回的命中列表 → `Map<sessionId, { snippet, textTruncated }>`。 */
export function contentMatchMap(results) {
  const map = new Map()
  for (const item of Array.isArray(results) ? results : []) {
    if (!item?.id || !item.snippet) continue
    map.set(item.id, item)
  }
  return map
}

function fieldRanges(value, tokens) {
  return value ? matchRanges(foldSearchText(value), tokens) : []
}

function itemFor(
  { kind, id, session, draft, title, cwd, extras, content, label, updatedAtMs },
  tokens
) {
  const score = scoreSessionSearch({ title, cwd, id, extras, hasContent: !!content }, tokens)
  if (score < 0) return null
  return {
    kind,
    id,
    session: session || null,
    draft: draft || null,
    score,
    title,
    cwd,
    titleRanges: fieldRanges(title, tokens),
    cwdRanges: fieldRanges(cwd, tokens),
    snippet: content?.snippet || null,
    snippetTruncated: !!content?.textTruncated,
    label: label || '',
    updatedAtMs: Number(updatedAtMs) || 0
  }
}

/**
 * 已存在的会话：时间范围之外的一律不参与（标题命中也不例外——范围就是这个开关的语义，
 * 否则「最近 3 天」会把两年前的旧会话也捞出来，范围形同虚设）。
 *
 * `extras` 是分组名与定时任务内容：会话被放进分组、或者挂着定时循环时，用户会用那几个
 * 词来找它。
 */
export function buildSessionSearchResults({
  sessions,
  tokens,
  sinceMs = 0,
  contentMatches,
  loopOf = () => null,
  groupOf = () => null,
  sectionLabelOf = () => ''
}) {
  if (!tokens?.length) return []
  const items = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session?.id) continue
    if (sinceMs > 0 && (Number(session.updatedAtMs) || 0) < sinceMs) continue
    const loop = loopOf(session.id)
    const group = groupOf(session.id)
    const title = session.title || session.id
    const item = itemFor(
      {
        kind: 'session',
        id: session.id,
        session,
        title,
        cwd: session.cwd || '',
        extras: [group, loop?.task],
        content: contentMatches?.get(session.id),
        label: sectionLabelOf(session.id, group),
        updatedAtMs: session.updatedAtMs
      },
      tokens
    )
    if (item) items.push(item)
  }
  return items
}

/** 还没绑定会话的草稿页签：只有名字和工作目录可搜，没有正文。 */
export function buildDraftSearchResults({ drafts, tokens, now = Date.now() }) {
  if (!tokens?.length) return []
  const items = []
  for (const node of Array.isArray(drafts) ? drafts : []) {
    if (!node?.id) continue
    const item = itemFor(
      {
        kind: 'draft',
        id: node.id,
        draft: node,
        title: node.text || node.id,
        cwd: node.cwd || '',
        label: '未发送',
        updatedAtMs: now
      },
      tokens
    )
    if (item) items.push(item)
  }
  return items
}

/** 相关度优先，其次才是最近更新——搜索的第一诉求是「最像的排最前」，不是时间线。 */
export function rankSearchItems(items, limit = SESSION_SEARCH_RESULT_LIMIT) {
  const sorted = [...(Array.isArray(items) ? items : [])].sort(
    (a, b) => b.score - a.score || b.updatedAtMs - a.updatedAtMs
  )
  return { items: sorted.slice(0, limit), overflow: Math.max(0, sorted.length - limit) }
}
