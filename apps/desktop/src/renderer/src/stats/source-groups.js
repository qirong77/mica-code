// 「By source」表的纯数据层：把每一条来源（主对话 / 子代理 / 插件 / 内核兜底）摊平成
// 一行并定下显示名与副标题。命名与排序收在这里，表只负责画，便于单测。
//
// 这一层回答的是「这笔请求是谁发的、在干什么」。只写 `Auto Compact` 或 `delegation`
// 是不够的：用户看不出同一个功能为什么会有两行（插件自己发一次、内核兜底再发一次），
// 也看不出 `Implementer` 这种英文类型名是 subagent 插件提供的。所以每行都要带：
// 类型（主对话 / 子代理 / 插件 / 内核兜底）+ 具体名称 + 谁派发 + 用途。
import { USAGE_KIND_COLORS } from './usage-series'
import { USAGE_SOURCE_LABELS } from '@packages/mica-web-shared/usage-source.js'

/**
 * 每行标出的「谁花的」。不再按这四类分组：同一个功能可能同时出现在两处（自动压缩的
 * 模型摘要既可以由插件经 `ctx.llm` 发、也可以由内核起摘要子代理），分组会把它拆到两张
 * 小表里，让人以为记了两笔。摊平后按 token 排序，同一个功能的两条正好挨在一起。
 */
export const SOURCE_KIND_LABELS = USAGE_SOURCE_LABELS

/** 卡片底部那行图例：四类来源分别是什么，以及什么时候会出现。 */
export const SOURCE_KIND_HINTS = {
  main: '这条会话自己的请求：每轮对话、每次工具迭代各算一次',
  delegation: '主对话用 agent 工具派出去的子代理，类型由 subagent 插件提供',
  plugin: '插件自己发的请求：起标题、压缩摘要、记忆整理、旁问……',
  helper: '插件把活交给内核时由内核代发的请求（摘要子代理等）'
}

/**
 * 子代理类型的中文名。类型清单归 subagent 插件（`plugins/subagent/definitions.ts`），
 * 这里只做展示别名；没登记的类型原样显示，不猜归属。
 */
const SUBAGENT_TYPE_LABELS = {
  'general-purpose': '通用',
  Explore: '探索',
  Implementer: '实现',
  Reviewer: '审查',
  Tester: '测试',
  Planner: '规划',
  Proposal: '方案'
}

/**
 * 内核自己写下的 helper 记录没有 pluginId，用中文名呈现：`compact` 是压缩摘要请求，
 * `memory-curator` 是记忆整理，`btw` 是旁问。
 *
 * 名字后面带「内核兜底」是为了让同一功能的另一条能对上：插件自己发请求时叫「会话压缩」
 * （标签「插件」），宿主没给插件模型接口、或插件没配自己的摘要模型时就是这行。
 */
const HELPER_LABELS = {
  compaction: '上下文压缩（内核兜底）',
  memory: '记忆整理（内核兜底）',
  btw: '旁问（内核兜底）'
}

/**
 * 内核功能的归一键：`memory-curator` 是记忆整理（压缩摘要的记录直接叫 `compact`）。
 */
const HELPER_FUNCTION_KEYS = {
  compact: 'compaction',
  'memory-curator': 'memory'
}

/**
 * 一行的聚合键：同一个功能只占一行，其它来源按自己的 id 分开（不同子代理类型、不同插件
 * 互不相干）。
 */
export function sourceRowKey(row) {
  return `${row?.kind}:${normalizeSourceId(row?.kind, row?.id)}`
}

/** 把内核功能的写法归一到功能键：`compact` 指压缩摘要，`memory-curator` 指记忆整理。 */
export function normalizeSourceId(kind, id) {
  if (kind === 'helper') return HELPER_FUNCTION_KEYS[id] || id
  return id
}

function subagentTypeLabel(type) {
  return SUBAGENT_TYPE_LABELS[type] || type
}

/** 一行的显示名：插件优先用清单里的名字，找不到（已卸载）就退回 id。 */
export function sourceTitle(row, pluginNames) {
  const id = normalizeSourceId(row.kind, row.id)
  if (row.kind === 'main') return SOURCE_KIND_LABELS.main
  if (row.kind === 'plugin') {
    return pluginNames?.get?.(row.id) || row.id || SOURCE_KIND_LABELS.plugin
  }
  if (row.kind === 'helper') {
    if (HELPER_LABELS[id]) return HELPER_LABELS[id]
    return id === 'helper' ? SOURCE_KIND_LABELS.helper : id || SOURCE_KIND_LABELS.helper
  }
  if (row.kind === 'delegation') {
    const type = row.id && row.id !== 'delegation' ? subagentTypeLabel(row.id) : ''
    return type ? `${SOURCE_KIND_LABELS.delegation} · ${type}` : SOURCE_KIND_LABELS.delegation
  }
  return row.id || SOURCE_KIND_LABELS[row.kind] || row.kind
}

// 副标题只有一行（Source 列约 300px、11px 字号），超过这个长度在表里就是省略号，
// 全文留在 `title` 悬停里。
const DESCRIPTION_MAX = 26

/** 用途（子代理任务的 description）或插件清单描述，截到一句话的长度。 */
function purposeText(purposes) {
  if (!purposes?.length) return ''
  const first = purposes[0].replace(/\s+/g, ' ').trim()
  const clipped =
    first.length > DESCRIPTION_MAX ? `${first.slice(0, DESCRIPTION_MAX).trimEnd()}…` : first
  return purposes.length > 1 ? `${clipped} +${purposes.length - 1}` : clipped
}

/**
 * 一行的副标题：谁派发、原始 id（名称是别名时才有）、会话数 / 任务数、用途。
 *
 * 委派行的用途是每个任务的 prompt 摘要（十几个任务拼起来就是一大段），所以只取第一条
 * 并标出还有几条；插件行用清单里的描述，说明这个插件本身是干什么的。
 */
export function sourceDetail(row, title, pluginDescriptions) {
  const parts = []
  if (row.kind === 'delegation') {
    parts.push('经 agent 工具派出')
    if (row.tasks > 0) parts.push(countLabel(row.tasks, 'task'))
  } else if (row.kind === 'plugin') {
    if (row.id && row.id !== title) parts.push(row.id)
    if (row.sessions > 0) parts.push(countLabel(row.sessions, 'session'))
    const description = pluginDescriptions?.get?.(row.id)
    if (description) parts.push(purposeText([description]))
  } else if (row.kind === 'helper') {
    if (row.sessions > 0) parts.push(countLabel(row.sessions, 'session'))
    const purpose = purposeText(row.purposes)
    if (purpose) parts.push(purpose)
  } else {
    if (row.sessions > 0) parts.push(countLabel(row.sessions, 'session'))
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
 * `pluginNames` / `pluginDescriptions` 是 `Map<pluginId, string>`，来自配置页那份插件清单：
 * 插件的显示名与描述属于清单，不在这里写死——用户插件与官方插件、装过又卸掉的插件都走
 * 同一条路。
 */
export function flattenSourceRows(rows, { pluginNames, pluginDescriptions } = {}) {
  const list = rows || []
  const total = list.reduce((sum, row) => sum + (Number(row.totalTokens) || 0), 0)
  const flattened = list
    .map((row) => {
      const title = sourceTitle(row, pluginNames)
      return {
        ...row,
        title,
        detail: sourceDetail(row, title, pluginDescriptions),
        kindLabel: SOURCE_KIND_LABELS[row.kind] || row.kind,
        kindHint: SOURCE_KIND_HINTS[row.kind] || '',
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
