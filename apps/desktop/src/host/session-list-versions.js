import { randomUUID } from 'node:crypto'

/** 仅缓存少量进程内版本：正常刷新只发送变更行，首次连接和版本过期发送完整索引。 */
export function createSessionListVersions({ maxVersions = 4, generation = randomUUID() } = {}) {
  let sequence = 0
  let current = null
  const versions = new Map()

  return function listSessions(rows, { since = '', delta = false } = {}) {
    if (current?.rows !== rows) {
      const signatures = new Map(rows.map((row) => [row.id, JSON.stringify(row)]))
      current = { rows, signatures, etag: `${generation}:${++sequence}` }
      versions.set(current.etag, current)
      while (versions.size > Math.max(1, maxVersions)) versions.delete(versions.keys().next().value)
    }
    const { etag } = current
    if (since === etag) return { sessions: [], etag, unchanged: true }
    const base = delta && versions.get(since)
    if (base) {
      const changed = rows.filter(
        (row) => base.signatures.get(row.id) !== current.signatures.get(row.id)
      )
      const removed = [...base.signatures.keys()].filter((id) => !current.signatures.has(id))
      if (changed.length < rows.length / 2 || !rows.length) {
        return {
          sessions: changed,
          removed,
          order: rows.map((row) => row.id),
          delta: true,
          baseEtag: since,
          etag,
          unchanged: false
        }
      }
    }
    return { sessions: rows, delta: false, etag, unchanged: false }
  }
}
