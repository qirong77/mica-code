/**
 * 自动压缩（auto compact）的纯数据模型：`userData/auto-compact.json` 的形状与校验。
 *
 * 与定时循环（loop-state.js）同一套边界：全局设置 + 按会话记的运行次数都活在运行时进程里，
 * 页面只是视图。每次 `turn/start` 把「设置 + 该会话已运行次数」一起下发给常驻的
 * `mica app-server`（见 host/auto-compact.js），host 每压一次再回推
 * `mica/autoCompact/updated`，计数记回这里。
 *
 * 计数只是展示用的账本（这个会话压过几次、省了多少 token），丢了不影响压缩本身，所以非法值
 * 一律收敛到默认值，而不是让运行时读不动设置。
 */

export const AUTO_COMPACT_VERSION = 1
/** 计数条目的上限：会话开得很多时文件也不能无限长，超了丢最久没动过的那些。 */
export const MAX_AUTO_COMPACT_COUNTERS = 200

export const DEFAULT_AUTO_COMPACT_SETTINGS = {
  enabled: true,
  quickThresholdK: 200,
  quickLimit: 3,
  modelThresholdK: 120,
  modelLimit: 3
}

/** 阈值按 K 计、次数上限按次计（0 次表示不做这一类压缩）。 */
const THRESHOLD_RANGE = { min: 1, max: 10_000 }
const COUNT_RANGE = { min: 0, max: 999 }

const DEFAULTS = DEFAULT_AUTO_COMPACT_SETTINGS

/** 只接受真正的数字（含数字字符串）：手改文件里的 null/true/"" 不该被当成 0。 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 越界钳制到边界、非法回落默认：用户明确给的值尽量保住，垃圾值不污染设置。 */
function clampInteger(value, fallback, { min, max }) {
  const number = toFiniteNumber(value)
  if (number === null) return fallback
  return Math.min(Math.max(Math.round(number), min), max)
}

/** 计数是非负整数：负数、小数、垃圾值一律收敛成 0。 */
function toCount(value) {
  const number = toFiniteNumber(value)
  if (number === null || number <= 0) return 0
  return Math.round(number)
}

function toText(value) {
  return typeof value === 'string' && value ? value : null
}

export function normalizeAutoCompactSettings(input) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    quickThresholdK: clampInteger(raw.quickThresholdK, DEFAULTS.quickThresholdK, THRESHOLD_RANGE),
    quickLimit: clampInteger(raw.quickLimit, DEFAULTS.quickLimit, COUNT_RANGE),
    modelThresholdK: clampInteger(raw.modelThresholdK, DEFAULTS.modelThresholdK, THRESHOLD_RANGE),
    modelLimit: clampInteger(raw.modelLimit, DEFAULTS.modelLimit, COUNT_RANGE)
  }
}

export function emptyCounters() {
  return {
    quickRuns: 0,
    modelRuns: 0,
    lastRunAt: null,
    lastKind: null,
    lastSavedTokens: 0,
    lastNote: null
  }
}

export function normalizeCounters(input) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    quickRuns: toCount(raw.quickRuns),
    modelRuns: toCount(raw.modelRuns),
    lastRunAt: toText(raw.lastRunAt),
    // 认不出类型就当作「没跑过」：徽标宁可显示未运行，也不要显示错的压缩类型
    lastKind: raw.lastKind === 'quick' || raw.lastKind === 'model' ? raw.lastKind : null,
    lastSavedTokens: toCount(raw.lastSavedTokens),
    lastNote: toText(raw.lastNote)
  }
}

export function emptyAutoCompactState() {
  return { version: AUTO_COMPACT_VERSION, settings: { ...DEFAULTS }, counters: {} }
}

function timestampOf(counters) {
  const at = Date.parse(toText(counters?.lastRunAt) || '')
  return Number.isFinite(at) ? at : 0
}

/**
 * 条目数封顶。丢弃顺序按 `lastRunAt` 从旧到新，没有时间戳（从没压缩成功过）的最先丢；
 * 时间相同的按插入顺序稳定排列，所以丢掉的永远是「最久没动过」的那些，行为可复现。
 */
function capCounters(counters) {
  const entries = Object.entries(counters)
  if (entries.length <= MAX_AUTO_COMPACT_COUNTERS) return counters
  const kept = entries
    .sort(([, a], [, b]) => timestampOf(a) - timestampOf(b))
    .slice(entries.length - MAX_AUTO_COMPACT_COUNTERS)
  return Object.fromEntries(kept)
}

export function normalizeAutoCompactState(input) {
  if (!input || typeof input !== 'object') return emptyAutoCompactState()
  const counters = {}
  const raw = input.counters
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [sessionId, value] of Object.entries(raw)) {
      // 非对象条目只可能来自手改文件：丢掉比留到后面让别处崩掉好
      if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) continue
      counters[sessionId] = normalizeCounters(value)
    }
  }
  return {
    version: AUTO_COMPACT_VERSION,
    settings: normalizeAutoCompactSettings(input.settings),
    counters: capCounters(counters)
  }
}

function countersFor(state, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return null
  return state?.counters?.[id] || null
}

/**
 * 记一次压缩结果（host 回推的 `mica/autoCompact/updated`）。没有变化时原样返回同一份状态，
 * 调用方据此跳过落盘与广播。
 */
export function applyAutoCompactStatus(state, sessionId, status) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return state
  const base = state && typeof state === 'object' ? state : emptyAutoCompactState()
  const next = normalizeCounters(status)
  const current = base.counters?.[id]
  if (current && JSON.stringify(current) === JSON.stringify(next)) return state
  return { ...base, counters: capCounters({ ...base.counters, [id]: next }) }
}

export function resetAutoCompactCounters(state, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id || !state?.counters || !(id in state.counters)) return state
  const counters = { ...state.counters }
  delete counters[id]
  return { ...state, counters }
}

/**
 * 每次 `turn/start` 带上的一份参数：设置 + 该会话已经用掉几次。没有记录的会话（还没压过、
 * 或草稿还没拿到 sessionId）就是全零，host 侧照样能按设置工作。
 */
export function readAutoCompactTurnParams(state, sessionId) {
  const settings = state?.settings || normalizeAutoCompactSettings(null)
  const counters = countersFor(state, sessionId) || emptyCounters()
  return {
    enabled: settings.enabled,
    quickThresholdK: settings.quickThresholdK,
    quickLimit: settings.quickLimit,
    quickRuns: counters.quickRuns,
    modelThresholdK: settings.modelThresholdK,
    modelLimit: settings.modelLimit,
    modelRuns: counters.modelRuns
  }
}
