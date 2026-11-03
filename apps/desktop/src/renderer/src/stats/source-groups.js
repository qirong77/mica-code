// 「By source」表的纯数据层：把每一条来源（主对话 / 内核后台 / 插件 / 委派类型）摊平成
// 一行并定下显示名与副标题。命名与排序收在这里，表只负责画，便于单测。
import { USAGE_KIND_COLORS, USAGE_KIND_LABELS } from './usage-series'

/**
 * 每行标出的「谁花的」。不再按这四类分组：同一个功能可能同时出现在两处（自动压缩的
 * 模型摘要既可以由插件经 `ctx.llm` 发、也可以由内核起摘要子代理），分组会把它拆到两张
 * 小表里，让人以为记了两笔。摊平后按 token 排序，同一个 id 的两条正好挨在一起。
 */
export const SOURCE_KIND_LABELS = {
  main: '主对话',
  delegation: '委派',
  plugin: '插件',
  helper: '内核'
}

/**
 * 内核自己写下的 helper 记录没有 pluginId，用中文名呈现：`compact` / `auto-compact` 是
 * 压缩摘要请求，`btw` 是旁问线程。插件自己的请求一律带 pluginId 走插件名，不靠这张表
 * 认领——认不出来的 id 原样显示，不猜归属。
 */
const HELPER_LABELS = {
  compact: '上下文压缩',
  'auto-compact': '上下文压缩',
  btw: '旁问'
}

/** 一行的显示名：插件优先用清单里的名字，找不到（已卸载）就退回 id。 */
export function sourceTitle(row, pluginNames) {
  if (row.kind === 'main') return USAGE_KIND_LABELS.main
  if (row.kind === 'plugin') return pluginNames?.get?.(row.id) || row.id || USAGE_KIND_LABELS.plugin
  if (row.kind === 'helper') {
    if (HELPER_LABELS[row.id]) return HELPER_LABELS[row.id]
    return row.id === 'helper' ? USAGE_KIND_LABELS.helper : row.id || USAGE_KIND_LABELS.helper
  }
  return row.id || USAGE_KIND_LABELS[row.kind] || row.kind
}

/**
 * 一行的副标题：来源类型、原始 id（名称是别名时才有）、会话数、用途。
 * 委派行的用途是每个任务的 prompt 摘要（十几个任务拼起来就是一大段），所以委派只报
 * 任务数，插件 / 内核才列用途。
 */
export function sourceDetail(row, title) {
  const parts = []
  const kindLabel = SOURCE_KIND_LABELS[row.kind]
  if (row.kind !== 'main' && kindLabel) parts.push(kindLabel)
  if (row.kind !== 'main' && row.id && row.id !== title) parts.push(row.id)
  if (row.sessions > 0) parts.push(countLabel(row.sessions, 'session'))
  if (row.kind === 'delegation') {
    if (row.tasks > 0) parts.push(countLabel(row.tasks, 'task'))
  } else if (row.purposes?.length > 0) {
    const shown = row.purposes.slice(0, 2).join(' / ')
    parts.push(row.purposes.length > 2 ? `${shown} +${row.purposes.length - 2}` : shown)
  }
  return parts.join(' · ')
}

/** `1 session` / `2 sessions`：副标题是给人读的一句话，不该出现「1 sessions」。 */
function countLabel(count, noun) {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`
}

/**
 * 把聚合好的来源行摊平（不再分组），按 token 降序，并带上显示名、副标题、颜色与类型标签。
 *
 * `pluginNames` 是 `Map<pluginId, name>`，来自配置页那份插件清单：插件的显示名属于清单，
 * 不在这里写死——用户插件与官方插件、装过又卸掉的插件都走同一条路。
 */
export function flattenSourceRows(rows, { pluginNames } = {}) {
  const list = rows || []
  const total = list.reduce((sum, row) => sum + (Number(row.totalTokens) || 0), 0)
  const flattened = list
    .map((row) => {
      const title = sourceTitle(row, pluginNames)
      return {
        ...row,
        title,
        detail: sourceDetail(row, title),
        kindLabel: SOURCE_KIND_LABELS[row.kind] || row.kind,
        color: USAGE_KIND_COLORS[row.kind] || 'var(--color-fg-muted)',
        share: total > 0 ? (Number(row.totalTokens) || 0) / total : 0
      }
    })
    .sort(
      (a, b) =>
        (Number(b.totalTokens) || 0) - (Number(a.totalTokens) || 0) || a.id.localeCompare(b.id)
    )
  return { total, rows: flattened }
}
