/** 返回 null 表示增量基线失配，调用方应重读完整索引，不能把部分行当成全部列表。 */
export function applySessionListUpdate(previous, result, previousEtag) {
  if (result?.unchanged) return previous
  if (!Array.isArray(result?.sessions)) return null
  if (!result.delta) return result.sessions
  if (
    result.baseEtag !== previousEtag ||
    !Array.isArray(result.order) ||
    !Array.isArray(result.removed)
  )
    return null
  const rows = new Map(previous.map((row) => [row.id, row]))
  for (const id of result.removed) rows.delete(id)
  for (const row of result.sessions) {
    if (!row?.id) return null
    rows.set(row.id, row)
  }
  if (rows.size !== result.order.length || new Set(result.order).size !== result.order.length)
    return null
  const ordered = result.order.map((id) => rows.get(id))
  return ordered.every(Boolean) ? ordered : null
}
