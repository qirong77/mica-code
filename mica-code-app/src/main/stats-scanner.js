import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { dedupeStatsSessions, parseStatsSession } from './stats-core'

function timestampPart(stat, name) {
  const nanoseconds = stat[`${name}Ns`]
  if (typeof nanoseconds === 'bigint') return nanoseconds.toString()
  const milliseconds = stat[`${name}Ms`]
  return typeof milliseconds === 'bigint' ? milliseconds.toString() : String(milliseconds)
}

/** Use all identity/content fields available from stat. */
function fileSignature(fileSystem, file) {
  let stat
  try {
    stat = fileSystem.statSync(file, { bigint: true })
  } catch (error) {
    // Some injected/older file-system implementations do not support bigint stats.
    if (!(error instanceof TypeError)) throw error
    stat = fileSystem.statSync(file)
  }
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.size),
    timestampPart(stat, 'mtime'),
    timestampPart(stat, 'ctime')
  ].join(':')
}

/** Keep this projection aligned with the session-list behavior in stats.js. */
function parseSessionMeta(raw) {
  const updatedAtMs = Date.parse(raw.updatedAt)
  if (!Number.isFinite(updatedAtMs)) return null
  const createdAtMs = Date.parse(raw.createdAt)
  return {
    id: raw.id || null,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
    updatedAtMs,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    turnState: raw.turnState || 'completed'
  }
}

/**
 * Incrementally scans a session directory. Metadata and full statistics are
 * projected lazily so the always-visible session list does not retain Stats
 * payloads unless the Stats view is actually opened.
 */
export function createStatsScanner({
  directory,
  fileSystem = nodeFs,
  parseStats = parseStatsSession,
  dedupeStats = dedupeStatsSessions
}) {
  if (typeof directory !== 'function') throw new TypeError('directory must be a function')

  const entries = new Map()
  let metaRevision = 0
  let statsRevision = 0
  let cachedMeta = null
  let cachedStats = null

  function invalidate(file) {
    if (!entries.delete(file)) return
    metaRevision += 1
    statsRevision += 1
  }

  function entryFor(file, signature) {
    const existing = entries.get(file)
    if (existing?.signature === signature) return existing
    if (existing) invalidate(file)
    const entry = {
      signature,
      metaLoaded: false,
      meta: null,
      statsLoaded: false,
      stats: null
    }
    entries.set(file, entry)
    // A new or replaced file can affect either projection.
    metaRevision += 1
    statsRevision += 1
    return entry
  }

  function readProjection(file, signature, kind) {
    const entry = entryFor(file, signature)
    const loadedKey = kind === 'meta' ? 'metaLoaded' : 'statsLoaded'
    if (entry[loadedKey]) return { stable: true, value: entry[kind] }

    let value = null
    try {
      const raw = JSON.parse(fileSystem.readFileSync(file, 'utf8'))
      value = kind === 'meta' ? parseSessionMeta(raw) : parseStats(raw)
    } catch {
      // A stable read/parse failure is cached as null for this projection.
    }

    let signatureAfter = null
    try {
      signatureAfter = fileSignature(fileSystem, file)
    } catch {
      // The file disappeared or changed identity while it was being read.
    }
    if (signatureAfter !== signature) {
      invalidate(file)
      return { stable: false, value: null }
    }

    entry[loadedKey] = true
    entry[kind] = value
    if (kind === 'meta') metaRevision += 1
    else statsRevision += 1
    return { stable: true, value }
  }

  function currentRows(kind) {
    const dir = directory()
    let names
    try {
      names = fileSystem.readdirSync(dir).filter((name) => name.endsWith('.json'))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (entries.size > 0) {
          entries.clear()
          metaRevision += 1
          statsRevision += 1
        }
        return { rows: [], stable: true }
      }
      // Preserve the last stable projection on transient EMFILE/EACCES/I/O
      // failures. Mark it unstable so callers do not replace their cache.
      const loadedKey = kind === 'meta' ? 'metaLoaded' : 'statsLoaded'
      return {
        rows: [...entries.values()].filter((entry) => entry[loadedKey]).map((entry) => entry[kind]).filter(Boolean),
        stable: false
      }
    }

    const listedFiles = new Set(names.map((name) => join(dir, name)))
    for (const file of entries.keys()) {
      if (!listedFiles.has(file)) invalidate(file)
    }

    const rows = []
    let stable = true
    for (const file of listedFiles) {
      let signature
      try {
        signature = fileSignature(fileSystem, file)
      } catch {
        invalidate(file)
        stable = false
        continue
      }
      const result = readProjection(file, signature, kind)
      stable &&= result.stable
      if (result.value) rows.push(result.value)
    }
    return { rows, stable }
  }

  return {
    scanMeta() {
      const { rows, stable } = currentRows('meta')
      if (stable && cachedMeta?.revision === metaRevision) return cachedMeta.value
      const value = rows.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      if (stable) cachedMeta = { revision: metaRevision, value }
      return value
    },

    scanStats() {
      const { rows, stable } = currentRows('stats')
      if (stable && cachedStats?.revision === statsRevision) return cachedStats.value
      const value = dedupeStats(rows)
      if (stable) cachedStats = { revision: statsRevision, value }
      return value
    }
  }
}
