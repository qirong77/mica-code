/**
 * 会话里的压缩块。
 *
 * 模型压缩会在历史里留下两条内部消息：boundary（一整段元数据 JSON）和 checkpoint
 * （摘要长文）。它们不是用户说的话，逐条当用户消息渲染时，对话流里就凭空多出一坨
 * JSON 加一大段英文。这里把同一个 checkpoint 的两条合成一块：元数据只用来生成那行
 * 「压缩了多少、保留了什么」，正文留给展开时看。
 */

/** 与 packages/mica-context 的 COMPACT_BOUNDARY_PREFIX / COMPACT_SUMMARY_PREFIX 一致。 */
export const COMPACT_BOUNDARY_PREFIX = '[Mica compact boundary]'
export const COMPACT_SUMMARY_PREFIX = '[Mica compact checkpoint]'

/** boundary 是内部状态 JSON；解析失败就当没有元数据，不影响摘要正文。 */
export function parseCompactBoundary(text) {
  const body = String(text ?? '').slice(COMPACT_BOUNDARY_PREFIX.length).trim()
  let meta
  try {
    meta = JSON.parse(body)
  } catch {
    return {}
  }
  if (!meta || typeof meta !== 'object') return {}
  return {
    createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : null,
    beforeTokens: positiveOrNull(meta.beforeTokenEstimate),
    keptTokens: positiveOrNull(meta.keptTokenEstimate),
    summarizedCount: positiveOrNull(meta.summarizedCount),
    keptCount: positiveOrNull(meta.keptCount)
  }
}

/** checkpoint 正文：去掉前缀和那段给模型看的英文开场白。 */
export function parseCompactCheckpoint(text) {
  return String(text ?? '')
    .slice(COMPACT_SUMMARY_PREFIX.length)
    .replace(/^\s*This session is being continued from a previous conversation\.[^\n]*\n?/i, '')
    .trim()
}

/**
 * 把 boundary + checkpoint 合成一条 `kind: 'compact'` 记录。
 *
 * 单独的 boundary 不进对话流：它是内部元数据，人类读不了；找不到 checkpoint 的
 * boundary 直接丢掉。
 */
export function mergeCompactCheckpoints(rows) {
  const merged = []
  let meta = null
  for (const row of Array.isArray(rows) ? rows : []) {
    const head = String(row?.text ?? '').trimStart()
    if (head.startsWith(COMPACT_BOUNDARY_PREFIX)) {
      meta = parseCompactBoundary(head)
      continue
    }
    if (head.startsWith(COMPACT_SUMMARY_PREFIX)) {
      merged.push({
        ...row,
        role: 'assistant',
        kind: 'compact',
        text: parseCompactCheckpoint(head),
        compact: meta ?? {}
      })
      meta = null
      continue
    }
    merged.push(row)
  }
  return merged
}

function positiveOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}
