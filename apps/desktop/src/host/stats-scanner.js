import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { parseSessionEvents, parseSessionText, summarizeStatsSession } from './stats-core'

/** 索引格式版本。形态一变就整份重建，不做迁移。 */
const INDEX_VERSION = 1
/** 每批解析多少个会话文件就让出一次事件循环。 */
const BATCH_FILES = 16
/** 单批最多占用主线程多久（毫秒）；大会话文件会超过这个预算，靠批次之间让出恢复响应。 */
const BATCH_BUDGET_MS = 12

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
  // 与 CLI 的 parsePersistedSession 保持一致的轻量校验：结构不完整的会话
  // 无法被 mica run/compact 恢复，不进入侧栏列表，避免点击后报
  // "Session not found: <id>"。
  if (!raw || typeof raw !== 'object') return null
  if (raw.version !== 1) return null
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null
  const snapshot = raw.snapshot
  if (!snapshot || typeof snapshot !== 'object') return null
  if (!Array.isArray(snapshot.messages) || !Array.isArray(snapshot.conversationMessages))
    return null
  // 档位名随模型而变，白名单会把 `max` / `minimal` 这类真实档位整条会话丢掉。
  if (typeof snapshot.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(snapshot.effort))
    return null
  const updatedAtMs = Date.parse(raw.updatedAt)
  if (!Number.isFinite(updatedAtMs)) return null
  const createdAtMs = Date.parse(raw.createdAt)
  // 侧栏据此把子会话挂到父会话下面。没有父会话时整个键都不出现：行对象的形状对
  // 「有没有派生关系」保持稳定，也让缓存指纹不必为一个 null 多记一个字段。
  const parentSessionId =
    typeof raw.parentSessionId === 'string' && raw.parentSessionId.trim()
      ? raw.parentSessionId.trim()
      : null
  return {
    id: raw.id || null,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
    ...(parentSessionId ? { parentSessionId } : {}),
    updatedAtMs,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    turnState: raw.turnState || 'completed'
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 扫描会话目录，产出两份投影：
 *
 * - `meta`：侧栏用的轻量行；
 * - `stats`：统计页用的「会话 × 本地日」聚合行（见 stats-core 的 summarizeStatsSession）。
 *
 * 统计投影以前要整份 JSON.parse 所有会话文件（上千个文件、几百 MB），而且同步跑在主
 * 进程里——点开 Stats 会把整个运行时按住好几秒。现在结果按文件签名缓存在
 * `stats-index.json` 里，进程重启后只解析变过的文件；首次构建分批让出事件循环，界面
 * 全程可交互。
 *
 * 跨会话去重（老 fork 文件复制了源会话的用量记录）仍然按事件身份判给最早创建的会话，
 * 只是改成在聚合之前做：每个会话文件里的用量事件身份一并存进索引，归属变化时重读受
 * 影响的文件重算。
 */
export function createStatsScanner({
  directory,
  indexFile = null,
  fileSystem = nodeFs,
  parseEvents = parseSessionEvents,
  summarize = summarizeStatsSession,
  parseText = parseSessionText,
  indexStore = null,
  onProgress = null,
  indexWriteDelayMs = 1000
}) {
  if (typeof directory !== 'function') throw new TypeError('directory must be a function')

  const entries = new Map()
  // 正文投影单独缓存：内容搜索不进扫描的统计/元数据缓存（那份按扫描签名维护，
  // 这里的读法不同），但同样按文件签名只解析一次。
  const textCache = new Map()
  let indexLoaded = false
  let indexDirty = false
  let writeTimer = null
  let inFlight = null
  let owners = null
  let ownersDirty = true
  // 行对象来自 entries，引用本来就稳定；数组也一起缓存，侧栏才能靠引用相等跳过重渲染。
  let metaCache = null
  let statsCache = null
  const progress = { building: false, done: 0, total: 0 }

  function invalidateRows() {
    metaCache = null
    statsCache = null
  }

  const store =
    indexStore ||
    (typeof indexFile === 'function'
      ? {
          async read() {
            return nodeFs.promises.readFile(indexFile(), 'utf8')
          },
          async write(text) {
            await nodeFs.promises.writeFile(indexFile(), text, 'utf8')
          }
        }
      : null)

  function signatureOf(file) {
    try {
      return fileSignature(fileSystem, file)
    } catch {
      return null
    }
  }

  async function loadIndex() {
    if (indexLoaded) return
    indexLoaded = true
    if (!store) return
    let parsed
    try {
      parsed = JSON.parse(await store.read())
    } catch {
      return
    }
    if (!parsed || parsed.version !== INDEX_VERSION || !parsed.files) return
    const dir = directory()
    for (const [name, entry] of Object.entries(parsed.files)) {
      if (!entry || typeof entry.signature !== 'string') continue
      if (!Array.isArray(entry.identities)) continue
      entries.set(join(dir, name), {
        signature: entry.signature,
        meta: entry.meta || null,
        stats: entry.stats || null,
        identities: entry.identities,
        owned: typeof entry.owned === 'number' ? entry.owned : 0
      })
    }
    ownersDirty = true
    invalidateRows()
  }

  /** 索引写在后台：整份重写几 MB，不值得让任何 IPC 等它。 */
  function scheduleIndexWrite() {
    if (!store || !indexDirty || writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      if (!indexDirty) return
      indexDirty = false
      const dir = directory()
      const files = {}
      for (const [file, entry] of entries) {
        files[file.slice(dir.length + 1)] = {
          signature: entry.signature,
          meta: entry.meta,
          stats: entry.stats,
          identities: entry.identities,
          owned: entry.owned
        }
      }
      Promise.resolve(store.write(JSON.stringify({ version: INDEX_VERSION, files }))).catch(
        () => {}
      )
    }, indexWriteDelayMs)
    writeTimer.unref?.()
  }

  function parseFile(file, signature) {
    let raw
    try {
      raw = JSON.parse(fileSystem.readFileSync(file, 'utf8'))
    } catch {
      // 结构损坏的文件按「没有投影」缓存，修好后签名变化会重新解析。
      return { meta: null, stats: null, identities: [], events: [] }
    }
    const after = signatureOf(file)
    if (after !== signature) return null
    const parsed = parseEvents(raw)
    return {
      meta: parseSessionMeta(raw),
      base: parsed?.session || null,
      events: parsed?.events || [],
      identities: parsed?.identities || []
    }
  }

  /** 归属表：一条用量事件身份属于最早创建的那个会话（并列时按 id 稳定排序）。 */
  function ensureOwners() {
    if (owners && !ownersDirty) return owners
    const ordered = [...entries.entries()].sort((a, b) => {
      const left = a[1].stats || a[1].meta || {}
      const right = b[1].stats || b[1].meta || {}
      const diff = (left.createdAtMs || 0) - (right.createdAtMs || 0)
      if (diff !== 0) return diff
      return String(left.id || a[0]).localeCompare(String(right.id || b[0]))
    })
    owners = new Map()
    for (const [file, entry] of ordered) {
      for (const identity of entry.identities) {
        if (!owners.has(identity)) owners.set(identity, file)
      }
    }
    ownersDirty = false
    return owners
  }

  function ownedCount(entry, file, ownerMap) {
    const seen = new Set()
    let count = 0
    for (const identity of entry.identities) {
      if (ownerMap.get(identity) !== file || seen.has(identity)) continue
      seen.add(identity)
      count += 1
    }
    return count
  }

  /**
   * 该会话真正拥有的用量事件：归属在它名下，且同一条记录在文件里重复出现时只算一次
   * （老 fork 快照里确实有逐字节重复的记录）。
   */
  function ownedEvents(file, events, ownerMap) {
    const seen = new Set()
    const owned = []
    for (const usage of events) {
      if (ownerMap.get(usage.identity) !== file) continue
      if (seen.has(usage.identity)) continue
      seen.add(usage.identity)
      owned.push(usage)
    }
    return owned
  }

  /** 把已解析的事件按归属聚合成日行；处理完就丢掉事件，不让上千个会话的事件常驻内存。 */
  function applyParsed(parsed, ownerMap) {
    for (const [file, result] of parsed) {
      const entry = entries.get(file)
      if (!entry) continue
      if (!result.base) {
        entry.stats = null
        entry.owned = 0
        invalidateRows()
        continue
      }
      const owned = ownedEvents(file, result.events, ownerMap)
      entry.stats = summarize(result.base, owned)
      entry.owned = owned.length
      invalidateRows()
    }
    parsed.clear()
  }

  async function doRefresh() {
    await loadIndex()
    const dir = directory()
    let names
    try {
      names = fileSystem.readdirSync(dir).filter((name) => name.endsWith('.json'))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (entries.size > 0) {
          entries.clear()
          textCache.clear()
          ownersDirty = true
          indexDirty = true
          invalidateRows()
          scheduleIndexWrite()
        }
        return
      }
      // 目录暂时读不到（EMFILE/EACCES/IO）时保留上一次的结果，本次不更新缓存。
      return
    }

    const listed = new Set(names.map((name) => join(dir, name)))
    for (const file of entries.keys()) {
      if (listed.has(file)) continue
      entries.delete(file)
      textCache.delete(file)
      ownersDirty = true
      indexDirty = true
      invalidateRows()
    }

    // 新文件按文件名倒序处理：文件名以创建时间戳开头，这样刚跑完的会话先出现在界面上。
    const pending = []
    for (const name of names) {
      const file = join(dir, name)
      const signature = signatureOf(file)
      if (!signature) {
        if (entries.delete(file)) {
          ownersDirty = true
          indexDirty = true
          invalidateRows()
        }
        continue
      }
      const entry = entries.get(file)
      if (entry?.signature === signature) continue
      pending.push({ file, signature })
    }
    pending.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))

    if (!pending.length && !ownersDirty) {
      progress.building = false
      scheduleIndexWrite()
      return
    }

    const parsed = new Map()
    const parsedFiles = new Set()
    progress.building = true
    progress.total = pending.length
    progress.done = 0
    let index = 0
    while (index < pending.length) {
      // 大会话文件单次 JSON.parse 就要几百毫秒，所以按时间切批：一批最多占用主线程
      // BATCH_BUDGET_MS，让出事件循环后再继续，IPC 不会被按住。
      const startedAt = Date.now()
      let taken = 0
      while (index < pending.length && taken < BATCH_FILES) {
        if (taken > 0 && Date.now() - startedAt >= BATCH_BUDGET_MS) break
        const { file, signature } = pending[index]
        index += 1
        taken += 1
        const result = parseFile(file, signature)
        // 读到一半被改写：下一次扫描重新读，这次不写缓存。
        if (!result) continue
        parsed.set(file, result)
        parsedFiles.add(file)
        entries.set(file, {
          signature,
          meta: result.meta,
          stats: null,
          identities: result.identities,
          owned: 0
        })
        invalidateRows()
        ownersDirty = true
      }
      progress.done = index
      onProgress?.(progress)
      await yieldToEventLoop()
    }
    const ownerMap = ensureOwners()
    applyParsed(parsed, ownerMap)
    progress.building = false
    onProgress?.(progress)

    // 归属变化（文件被删 / 老 fork 文件新增）会让未变化会话的去重结果失效：
    // 只对「拥有的记录数对不上」的那些会话重读一次文件，重算它们的日行。
    const stale = []
    for (const [file, entry] of entries) {
      if (parsedFiles.has(file) || !entry.stats) continue
      if (ownedCount(entry, file, ownerMap) === entry.owned) continue
      stale.push(file)
    }
    for (const file of stale) {
      const entry = entries.get(file)
      if (!entry) continue
      const result = parseFile(file, entry.signature)
      if (!result) continue
      entry.identities = result.identities
      entry.owned = 0
      if (result.base) {
        const owned = ownedEvents(file, result.events, ownerMap)
        entry.stats = summarize(result.base, owned)
        entry.owned = owned.length
      } else {
        entry.stats = null
      }
      invalidateRows()
    }
    if (parsedFiles.size || stale.length) indexDirty = true
    scheduleIndexWrite()
  }

  function refresh() {
    if (inFlight) return inFlight
    inFlight = doRefresh().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function metaRows() {
    const rows = []
    for (const entry of entries.values()) if (entry.meta) rows.push(entry.meta)
    return rows.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
  }

  function statsRows() {
    const rows = []
    for (const entry of entries.values()) if (entry.stats) rows.push(entry.stats)
    return rows.sort(
      (a, b) => a.createdAtMs - b.createdAtMs || String(a.id).localeCompare(String(b.id))
    )
  }

  return {
    progress,

    /** 侧栏会话列表：最近更新的在前。 */
    async scanMeta() {
      // 索引还在构建时先给已解析的部分：页面收到 stats:changed 重读时能逐步填充，
      // 而不是所有请求一起挂到同一个扫描上、最后一次性出现。
      if (progress.building) return metaRows()
      await refresh()
      if (!metaCache) metaCache = metaRows()
      return metaCache
    },

    /** 统计页数据：按创建时间升序（与去重结果的稳定顺序一致）。 */
    async scanStats() {
      if (progress.building) return statsRows()
      await refresh()
      if (!statsCache) statsCache = statsRows()
      return statsCache
    },

    /** 该会话真正拥有的用量事件身份；未知会话返回 null（调用方原样返回记录）。 */
    async ownedIdentities(sessionId) {
      await refresh()
      const ownerMap = ensureOwners()
      for (const [file, entry] of entries) {
        const id = entry.stats?.id || entry.meta?.id
        if (id !== sessionId) continue
        const owned = new Set()
        for (const identity of entry.identities) {
          if (ownerMap.get(identity) === file) owned.add(identity)
        }
        return owned
      }
      return null
    },

    /**
     * 单个会话的正文投影（内容搜索用）。按文件签名增量缓存：同一份文件只在第一次搜索时
     * 解析一遍，之后每个查询都只在内存的字符串上匹配。文件在读取期间被改写时返回 null
     * （本次跳过，下一次搜索会重新读），不返回半份数据。
     */
    async readText(file) {
      const signature = signatureOf(file)
      if (!signature) return null
      const cached = textCache.get(file)
      if (cached?.signature === signature) return cached.value
      let raw
      try {
        raw = JSON.parse(fileSystem.readFileSync(file, 'utf8'))
      } catch {
        return null
      }
      if (signatureOf(file) !== signature) return null
      const value = parseText(raw)
      textCache.set(file, { signature, value })
      return value
    }
  }
}
