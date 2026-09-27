/**
 * 自动压缩（输入框右侧齿轮面板）在渲染层的纯逻辑：设置草稿的换算与校验、按钮与面板文案。
 *
 * 规则本身与按会话记账的计数都活在运行时里（`src/host/auto-compact.js`），页面只是读写
 * 视图。这里不碰 IPC，只把设置对象翻译成表单草稿、把计数翻译成界面文案。
 */

export const AUTO_COMPACT_THRESHOLD_MIN_K = 1
export const AUTO_COMPACT_THRESHOLD_MAX_K = 10_000
export const AUTO_COMPACT_LIMIT_MIN = 0
export const AUTO_COMPACT_LIMIT_MAX = 999

/** 与运行时侧的默认值一致：默认开启，快速 200k / 3 次、模型 120k / 3 次。 */
export const DEFAULT_AUTO_COMPACT_SETTINGS = {
  enabled: true,
  quickThresholdK: 200,
  quickLimit: 3,
  modelThresholdK: 120,
  modelLimit: 3
}

/** 某个会话还没有任何自动压缩记录时的计数形状。 */
export function emptyAutoCompactCounters() {
  return {
    quickRuns: 0,
    modelRuns: 0,
    lastRunAt: null,
    lastKind: null,
    lastSavedTokens: null,
    lastNote: ''
  }
}

function countOrZero(value) {
  const count = numberOr(value, 0)
  return count > 0 ? Math.floor(count) : 0
}

// null / 空串 / 非数字一律回落，不能靠 `Number()`：`Number(null)` 与 `Number('')` 都是 0，
// 会把「没配过」静默变成「上限 0 次」。
function numberOr(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return fallback
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : fallback
}

function limitOr(value, fallback) {
  const limit = numberOr(value, fallback)
  return limit >= 0 ? Math.floor(limit) : fallback
}

/**
 * 计数按 sessionId 归属（契约里 counters 是 `{[sessionId]: {...}}` 的整张表）。
 * 草稿会话还没有 sessionId、或表里没有这个会话时返回零值形状，调用方无需再判空。
 */
export function countersForSession(counters, sessionId) {
  const empty = emptyAutoCompactCounters()
  const id = typeof sessionId === 'string' ? sessionId : ''
  const entry = id && counters && typeof counters === 'object' ? counters[id] : null
  if (!entry || typeof entry !== 'object') return empty
  return {
    ...empty,
    ...entry,
    quickRuns: countOrZero(entry.quickRuns),
    modelRuns: countOrZero(entry.modelRuns)
  }
}

/** 设置 → 表单草稿：数字一律转成字符串，输入框才好编辑（空串代表用户清空了）。 */
export function autoCompactDraftFromSettings(settings) {
  const value = settings && typeof settings === 'object' ? settings : DEFAULT_AUTO_COMPACT_SETTINGS
  const defaults = DEFAULT_AUTO_COMPACT_SETTINGS
  return {
    enabled: value.enabled !== false,
    quickThresholdK: String(limitOr(value.quickThresholdK, defaults.quickThresholdK)),
    quickLimit: String(limitOr(value.quickLimit, defaults.quickLimit)),
    modelThresholdK: String(limitOr(value.modelThresholdK, defaults.modelThresholdK)),
    modelLimit: String(limitOr(value.modelLimit, defaults.modelLimit))
  }
}

const INTEGER_PATTERN = /^\d+$/

function parseIntegerField(raw, { min, max, label, unit }) {
  const text = String(raw ?? '').trim()
  if (!INTEGER_PATTERN.test(text)) {
    return { ok: false, error: `${label}需为 ${min}–${max} 之间的整数${unit}` }
  }
  const value = Number(text)
  if (value < min || value > max) {
    return { ok: false, error: `${label}需为 ${min}–${max} 之间的整数${unit}` }
  }
  return { ok: true, value }
}

/**
 * 表单草稿 → 设置。空串、非数字、越界都如实报错，不做静默兜底（否则用户改了半天却存了个
 * 别的值，问题只会在自动压缩跑起来时暴露）。
 */
export function autoCompactSettingsFromDraft(draft) {
  const source = draft && typeof draft === 'object' ? draft : {}
  const quickThreshold = parseIntegerField(source.quickThresholdK, {
    min: AUTO_COMPACT_THRESHOLD_MIN_K,
    max: AUTO_COMPACT_THRESHOLD_MAX_K,
    label: '快速压缩阈值',
    unit: '（单位 k）'
  })
  if (!quickThreshold.ok) return quickThreshold
  const quickLimit = parseIntegerField(source.quickLimit, {
    min: AUTO_COMPACT_LIMIT_MIN,
    max: AUTO_COMPACT_LIMIT_MAX,
    label: '快速压缩上限',
    unit: '（次）'
  })
  if (!quickLimit.ok) return quickLimit
  const modelThreshold = parseIntegerField(source.modelThresholdK, {
    min: AUTO_COMPACT_THRESHOLD_MIN_K,
    max: AUTO_COMPACT_THRESHOLD_MAX_K,
    label: '模型压缩阈值',
    unit: '（单位 k）'
  })
  if (!modelThreshold.ok) return modelThreshold
  const modelLimit = parseIntegerField(source.modelLimit, {
    min: AUTO_COMPACT_LIMIT_MIN,
    max: AUTO_COMPACT_LIMIT_MAX,
    label: '模型压缩上限',
    unit: '（次）'
  })
  if (!modelLimit.ok) return modelLimit
  return {
    ok: true,
    settings: {
      enabled: source.enabled !== false,
      quickThresholdK: quickThreshold.value,
      quickLimit: quickLimit.value,
      modelThresholdK: modelThreshold.value,
      modelLimit: modelLimit.value
    }
  }
}

/** 面板里的运行进度：`快速 2/3 · 模型 1/3`。 */
export function autoCompactRunLabel(counters, settings) {
  const entry = counters && typeof counters === 'object' ? counters : emptyAutoCompactCounters()
  const value = settings && typeof settings === 'object' ? settings : DEFAULT_AUTO_COMPACT_SETTINGS
  const quickLimit = limitOr(value.quickLimit, DEFAULT_AUTO_COMPACT_SETTINGS.quickLimit)
  const modelLimit = limitOr(value.modelLimit, DEFAULT_AUTO_COMPACT_SETTINGS.modelLimit)
  return `快速 ${countOrZero(entry.quickRuns)}/${quickLimit} · 模型 ${countOrZero(entry.modelRuns)}/${modelLimit}`
}

/** 齿轮按钮的悬停说明。 */
export function autoCompactTooltip({ settings, counters } = {}) {
  const value = settings && typeof settings === 'object' ? settings : DEFAULT_AUTO_COMPACT_SETTINGS
  if (value.enabled === false) return '自动压缩已关闭（点击设置）'
  return `自动压缩：已运行 ${autoCompactRunLabel(counters, value)}（点击设置）`
}
