// 会话详情「用量」页签的纯数据层：把主对话与各类子代理记录摊平成一条按时间排序的
// 请求序列，并按来源 / token 构成聚合。图表、表格与汇总卡片都读这一份，避免几处各算一套。
import { usageSourceOf } from '@packages/mica-web-shared/usage-source.js'

/** 四类来源的固定顺序：主对话在最前，插件在委派之后。 */
export const USAGE_KIND_ORDER = ['main', 'delegation', 'plugin', 'helper']

/**
 * 每一次模型请求都归到四类来源之一（判定在 `mica-web-shared/usage-source`），
 * 颜色只用来区分种类；同一个 kind 在统计页与会话详情里是同一种颜色，因为两边看的是同一笔账。
 */
export const USAGE_KIND_COLORS = {
  main: 'var(--color-fg-strong)',
  delegation: 'var(--color-info)',
  plugin: 'var(--color-accent)',
  helper: 'var(--color-fg-ghost)'
}

// 来源的中文名只有一份（`mica-web-shared` 的 `USAGE_SOURCE_LABELS`）：统计页的图例、
// 表格与会话详情都从这里取，不再各写一套同义词。
import { USAGE_SOURCE_LABELS } from '@packages/mica-web-shared/usage-source.js'

export const USAGE_KIND_LABELS = USAGE_SOURCE_LABELS

/** token 构成的三种去向：缓存输入、未缓存输入、输出。图形与图例共用这一份配色。 */
export const USAGE_TOKEN_PARTS = [
  { key: 'cached', label: '缓存输入', color: 'var(--color-fg-faint)' },
  { key: 'uncached', label: '未缓存输入', color: 'var(--color-info)' },
  { key: 'output', label: '输出', color: 'var(--color-accent)' }
]

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 一条请求的可画形态。`cached` 夹在 `input` 以内：个别 provider 会报出比输入更多的缓存
 * 命中（换模型、网关补报），不夹住就会画出负高度的堆叠段。
 */
export function projectRequest(usage, kind, sourceId) {
  const input = num(usage?.inputTokens)
  const cached = Math.min(input, num(usage?.cachedInputTokens))
  const output = num(usage?.outputTokens)
  return {
    key: usage?.usageId || null,
    at: usage?.occurredAt || null,
    model: usage?.model || null,
    kind,
    sourceId,
    sourceLabel: USAGE_KIND_LABELS[kind] ?? kind,
    input,
    cached,
    output,
    // 老记录里 totalTokens 可能缺省（只记了 in/out），退回两者之和，别让柱高变成 0。
    total: num(usage?.totalTokens) || input + output
  }
}

/**
 * 摊平一条会话的全部请求：主对话在前，子代理记录按写入顺序跟在后面，再按时间排序
 * （时间相同保持原顺序）。每条带上序号与累计 token，图表悬停时直接用。
 */
export function buildUsageSeries(usageHistory, records) {
  const requests = []
  for (const usage of usageHistory || []) requests.push(projectRequest(usage, 'main', 'main'))
  for (const record of records || []) {
    const source = usageSourceOf(record)
    for (const usage of record?.requests || []) {
      requests.push(projectRequest(usage, source.kind, source.id))
    }
  }
  requests.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))

  const totals = { requests: 0, input: 0, cached: 0, output: 0, total: 0 }
  for (const [index, request] of requests.entries()) {
    request.index = index
    request.cumulative = (requests[index - 1]?.cumulative || 0) + request.total
    totals.requests += 1
    totals.input += request.input
    totals.cached += request.cached
    totals.output += request.output
    totals.total += request.total
  }

  const byKind = USAGE_KIND_ORDER.map((kind) => {
    const row = {
      kind,
      label: USAGE_KIND_LABELS[kind],
      color: USAGE_KIND_COLORS[kind],
      requests: 0,
      input: 0,
      cached: 0,
      output: 0,
      total: 0
    }
    for (const request of requests) {
      if (request.kind !== kind) continue
      row.requests += 1
      row.input += request.input
      row.cached += request.cached
      row.output += request.output
      row.total += request.total
    }
    return row
  }).filter((row) => row.requests > 0)

  const uncached = Math.max(0, totals.input - totals.cached)
  return {
    requests,
    byKind,
    totals:
      totals.requests > 0
        ? { ...totals, cacheRate: totals.input > 0 ? totals.cached / totals.input : null }
        : { ...totals, cacheRate: null },
    composition: { cached: totals.cached, uncached, output: totals.output }
  }
}
