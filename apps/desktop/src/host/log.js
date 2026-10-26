// 本地诊断日志：desktop 运行时（host/server）各功能共用的唯一写入器。
//
// 目标不是遥测，而是「事后能查」。所以：
// - 位置在 os.tmpdir()/mica-logs/，macOS 开机由 launchd 清空，不需要保留策略；
// - JSONL 一行一个事件，直接 tail / grep / jq 就能看；
// - 内存排队 + 定时批量落盘，高频事件（如流式输出）不会把主线程拖慢；
// - 同时保留最近 N 条在内存里，供 `diagnostics:snapshot` 立刻取现场。
//
// 慢操作单独聚合：调用方用 `timed()` 包一层，超过阈值自动记一条 slow，
// 并累加到 `slowReport()`，用来回答「到底哪个功能在拖慢」。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const MAX_BYTES = 16 * 1024 * 1024
const KEEP_DAYS = 3
const RING_SIZE = 1000
const FLUSH_MS = 2000
const FLUSH_BATCH = 100
// 默认只看 warn 以上；排查时用 MICA_LOG_LEVEL=debug 打开全量。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const THRESHOLD = LEVELS[String(process.env.MICA_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info
// 慢操作阈值：超过就记为 slow（host 通道一次调用通常 < 50ms）。
export const SLOW_MS = Number(process.env.MICA_LOG_SLOW_MS || 300)

let queue = []
let ring = []
let flushTimer = null
let slowStats = new Map()
let dropped = 0

function logDir() {
  const dir = join(tmpdir(), 'mica-logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function dayStamp(now) {
  const d = new Date(now)
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('')
}

function fileFor(scope, now) {
  const dir = logDir()
  const base = join(dir, `${scope}-${dayStamp(now)}.jsonl`)
  try {
    if (!existsSync(base) || statSync(base).size <= MAX_BYTES) return base
  } catch {
    return base
  }
  return join(dir, `${scope}-${dayStamp(now)}-${now}.jsonl`)
}

// 长时间不重启时兜底清理；开机时整个 temp 会被 launchd 清空。
function prune(now) {
  const dir = logDir()
  const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
    } catch {
      // 删不掉不影响写入
    }
  }
}

function writeNow() {
  if (queue.length === 0) return
  const batch = queue
  queue = []
  const now = Date.now()
  // 按 scope 分组，避免一行写一个文件（缩小 fsync 次数）
  const byScope = new Map()
  for (const entry of batch) {
    const list = byScope.get(entry.scope) || []
    list.push(entry)
    byScope.set(entry.scope, list)
  }
  for (const [scope, entries] of byScope) {
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n')
    try {
      appendFileSync(fileFor(scope, now), `${body}\n`)
    } catch {
      dropped += entries.length
    }
  }
  prune(now)
}

function schedule() {
  if (flushTimer) return
  flushTimer = setInterval(writeNow, FLUSH_MS)
  // 不要因为这个定时器让进程无法退出
  if (typeof flushTimer.unref === 'function') flushTimer.unref()
}

function record(level, scope, event, fields) {
  if ((LEVELS[level] ?? 0) < THRESHOLD) return
  const entry = { at: Date.now(), level, scope, event, ...fields }
  queue.push(entry)
  ring.push(entry)
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)
  schedule()
  if (queue.length >= FLUSH_BATCH) writeNow()
}

function errorFields(error) {
  if (!error) return {}
  return {
    message: String(error.message || error),
    code: error.code,
    stack:
      typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 6).join('\n') : undefined
  }
}

export function logger(scope) {
  const log = (level) => (event, fields) => record(level, scope, event, fields)
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: (event, fields = {}) =>
      record('error', scope, event, { ...errorFields(fields.error), ...fields, error: undefined }),
    /** 执行并计时；超阈值记 slow。返回 fn 的结果，异常照常抛出并记录。 */
    async timed(event, fn, threshold = SLOW_MS) {
      const started = Date.now()
      try {
        const result = await fn()
        const ms = Date.now() - started
        noteSlow(scope, event, ms, threshold, true)
        return result
      } catch (error) {
        const ms = Date.now() - started
        noteSlow(scope, event, ms, threshold, false)
        record('error', scope, event, { ms, ...errorFields(error) })
        throw error
      }
    }
  }
}

function noteSlow(scope, event, ms, threshold, ok) {
  const key = `${scope}:${event}`
  const stat = slowStats.get(key) || { count: 0, totalMs: 0, maxMs: 0, slow: 0, fails: 0 }
  stat.count += 1
  stat.totalMs += ms
  stat.maxMs = Math.max(stat.maxMs, ms)
  if (!ok) stat.fails += 1
  if (ms >= threshold) {
    stat.slow += 1
    // 慢调用单独记一条 warn：这是「卡在哪」最直接的线索。
    record('warn', scope, event, { ms, kind: 'slow' })
  } else if (ok) {
    // 常态调用也记，否则 Performance 面板看不到各功能的基线耗时。
    // 用 kind:'call' 与应用事件区分，页面的事件流不展示它们（耗时时看聚合表）。
    record('info', scope, event, { ms, kind: 'call' })
  }
  slowStats.set(key, stat)
}

/** 最近的内存事件（含未落盘的），供 diagnostics:snapshot 使用。 */
export function snapshot(limit = 200) {
  return ring.slice(-limit).map((entry) => ({ ...entry }))
}

/** 按「平均耗时」排序的调用统计，直接回答「哪个功能慢」。 */
export function slowReport(limit = 30) {
  return [...slowStats.entries()]
    .map(([key, stat]) => ({
      key,
      count: stat.count,
      fails: stat.fails,
      slow: stat.slow,
      avgMs: Math.round(stat.totalMs / Math.max(1, stat.count)),
      maxMs: stat.maxMs
    }))
    .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count)
    .slice(0, limit)
}

export function stats() {
  return {
    queued: queue.length,
    ring: ring.length,
    dropped,
    slowKeys: slowStats.size,
    threshold: THRESHOLD,
    dir: logDir()
  }
}

/**
 * 读日志文件并聚合，供配置页的 Performance 面板使用。
 *
 * 只读最近 `maxBytes` 字节（从尾部取），避免一个 16MB 的文件把页面拖死；
 * 聚合在 host 做完再交出去，页面只负责渲染。
 */
export function readPerformanceSummary(options = {}) {
  const dir = logDir()
  const maxBytes = Math.min(Number(options?.maxBytes) || 4 * 1024 * 1024, 16 * 1024 * 1024)
  const eventLimit = Math.min(Number(options?.limit) || 300, 2000)
  const bucketLimit = Math.min(Number(options?.buckets) || 40, 200)
  const timelineLimit = Math.min(Number(options?.timeline) || 300, 2000)

  let names = []
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const path = join(dir, name)
        try {
          const info = statSync(path)
          return { name, path, bytes: info.size, modifiedAt: info.mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, 20)
  } catch {
    return emptySummary(dir)
  }

  const files = names.map(({ name, bytes, modifiedAt }) => ({ name, bytes, modifiedAt }))
  const entries = []
  let budget = maxBytes
  // 新的文件优先，直到预算用完
  for (const file of names) {
    if (budget <= 0) break
    try {
      const raw = readFileSync(file.path, 'utf8')
      const text = raw.length > budget ? raw.slice(raw.length - budget) : raw
      budget -= text.length
      // 截断后第一行可能不完整，丢掉
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          entries.push(JSON.parse(line))
        } catch {
          // 半行 / 非法行跳过
        }
      }
    } catch {
      // 读不了就跳过这个文件
    }
  }
  entries.sort((a, b) => (a.at || 0) - (b.at || 0))

  const buckets = new Map()
  const timeline = []
  let errors = 0
  let warns = 0
  let slowCalls = 0
  let samples = 0
  let hiddenSamples = 0
  let first = 0
  let last = 0

  for (const entry of entries) {
    const at = entry.at || 0
    if (at) {
      if (!first) first = at
      last = at
    }
    if (entry.level === 'error') errors += 1
    if (entry.level === 'warn') warns += 1

    // 渲染层采样点单独抽成时间线
    if (entry.scope === 'perf' && entry.event === 'sample') {
      // 隐藏窗口的采样没有 lag（定时器被节流，算出来全是假冻结），只留 DOM/堆，
      // 别让 Number(null) || 0 把它们混进「流畅」的那一档。
      if (entry.vis !== 1 || typeof entry.lag !== 'number') {
        hiddenSamples += 1
        continue
      }
      samples += 1
      timeline.push({
        at,
        lag: Number(entry.lag) || 0,
        long: Number(entry.long) || 0,
        longN: Number(entry.longN) || 0,
        dom: Number(entry.dom) || 0,
        heapMB: typeof entry.heapMB === 'number' ? entry.heapMB : undefined
      })
      continue
    }

    if (typeof entry.ms === 'number' && entry.scope !== 'perf') {
      const key = `${entry.scope}:${entry.event}`
      const bucket = buckets.get(key) || {
        scope: entry.scope,
        event: entry.event,
        count: 0,
        slow: 0,
        fails: 0,
        totalMs: 0,
        maxMs: 0
      }
      bucket.count += 1
      bucket.totalMs += entry.ms
      bucket.maxMs = Math.max(bucket.maxMs, entry.ms)
      if (entry.level === 'warn' && entry.kind === 'slow') {
        bucket.slow += 1
        slowCalls += 1
      }
      if (entry.level === 'error') bucket.fails += 1
      buckets.set(key, bucket)
    }
  }

  return {
    available: true,
    dir,
    files,
    totals: {
      events: entries.length,
      errors,
      warns,
      slowCalls,
      samples,
      hiddenSamples,
      spanMs: first && last ? last - first : 0
    },
    pending: queue.length,
    buckets: [...buckets.values()]
      .map((bucket) => ({
        scope: bucket.scope,
        event: bucket.event,
        count: bucket.count,
        slow: bucket.slow,
        fails: bucket.fails,
        avgMs: Math.round(bucket.totalMs / Math.max(1, bucket.count)),
        maxMs: Math.round(bucket.maxMs)
      }))
      .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count)
      .slice(0, bucketLimit),
    timeline: timeline.slice(-timelineLimit),
    events: entries
      // kind:'call' 是常态调用的耗时记录，已由聚合表呈现，事件流里不重复刷屏。
      .filter((entry) => entry.level !== 'debug' && entry.kind !== 'call')
      .slice(-eventLimit)
      .reverse()
      .map((entry) => ({
        at: entry.at || 0,
        level: entry.level || 'info',
        scope: entry.scope || 'unknown',
        event: entry.event || '',
        ms: entry.ms,
        lag: entry.lag,
        long: entry.long,
        longN: entry.longN,
        dom: entry.dom,
        rows: entry.rows,
        heapMB: entry.heapMB,
        vis: entry.vis,
        count: entry.count,
        error: entry.message || entry.error
      }))
  }
}

function emptySummary(dir) {
  return {
    available: true,
    dir,
    files: [],
    totals: { events: 0, errors: 0, warns: 0, slowCalls: 0, samples: 0, spanMs: 0 },
    pending: queue.length,
    buckets: [],
    timeline: [],
    events: []
  }
}

/** 清空当前日志目录（配置页上的「清空」按钮）。 */
export function clearLogs() {
  writeNow()
  const dir = logDir()
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return { removed: 0 }
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      unlinkSync(join(dir, name))
      removed += 1
    } catch {
      // 删不掉就留着
    }
  }
  ring = []
  slowStats = new Map()
  dropped = 0
  return { removed }
}

/** 退出前把剩余事件写完。 */
export function flushLogs() {
  writeNow()
}

/**
 * 注册诊断查询通道：`diagnostics:snapshot` 返回内存里最近的事件与慢调用统计。
 * 由 server 启动时调用一次；排查时直接 invoke 就能拿现场，不用去翻文件。
 */
export function registerDiagnosticsIpc(ipcMain) {
  ipcMain.handle('diagnostics:snapshot', (_event, options = {}) => {
    const limit = Math.min(Number(options?.limit) || 200, RING_SIZE)
    return {
      takenAt: Date.now(),
      stats: stats(),
      slow: slowReport(Math.min(Number(options?.slowLimit) || 30, 200)),
      events: snapshot(limit)
    }
  })

  // 渲染层把 console.error / 未捕获异常推过来，和 host 事件落在同一套日志里。
  ipcMain.handle('log:report', (_event, payload = {}) => {
    const entries = Array.isArray(payload?.entries) ? payload.entries : []
    const scope = typeof payload?.scope === 'string' && payload.scope ? payload.scope : 'renderer'
    const log = logger(scope)
    for (const entry of entries.slice(0, 200)) {
      if (!entry || typeof entry !== 'object') continue
      const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info'
      const { event, level: entryLevel, ...fields } = entry
      void entryLevel
      log[level](String(event || 'log').slice(0, 120), fields)
    }
    return { written: entries.length }
  })
}
