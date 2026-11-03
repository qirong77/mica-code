// 「By source」表的纯数据层：先把用量按「谁花的」分组（主 APP / 插件 / 委派子代理），
// 再给每一行定显示名与副标题。分组规则、命名与占比都收在这里，表只负责画，便于单测。
import { USAGE_KIND_COLORS, USAGE_KIND_LABELS } from './usage-series'

/**
 * 组的顺序就是「这笔钱是谁花的」：先这台机器自己（主对话 + 内核后台），再插件自己发的
 * 请求，最后主对话派出去的子代理。委派虽然也是插件提供的，但它花的是主对话的意图，
 * 和「插件自己干活」（起标题、整理记忆、压缩摘要）不是一回事，所以单列一组。
 */
export const SOURCE_GROUPS = [
  { key: 'app', label: '主 APP', kinds: ['main', 'helper'] },
  { key: 'plugin', label: '插件', kinds: ['plugin'] },
  { key: 'delegation', label: '委派子代理', kinds: ['delegation'] }
]

/**
 * 内核自己写下的 helper 记录没有 pluginId，用中文名呈现：`compact` / `auto-compact` 是
 * 压缩摘要请求，`btw` 是旁问线程。插件自己的请求一律带 pluginId 落进「插件」组，不靠
 * 这张表认领——认不出来的 id 原样显示，不猜归属。
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
 * 一行的副标题：原始 id（名称是别名时才有）、会话数、用途。
 * 委派行的用途是每个任务的 prompt 摘要（十几个任务拼起来就是一大段），所以委派只报任务数，
 * 插件 / 内核才列用途。
 */
export function sourceDetail(row, title) {
  const parts = []
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
 * 把聚合好的来源行分进三组（外加「其它」兜底），并带上组内小计与占比。
 *
 * `pluginNames` 是 `Map<pluginId, name>`，来自配置页那份插件清单：插件的显示名属于清单，
 * 不在这里写死——用户插件与官方插件、装过又卸掉的插件都走同一条路。
 */
export function groupSourceRows(rows, { pluginNames } = {}) {
  const list = rows || []
  const total = list.reduce((sum, row) => sum + (Number(row.totalTokens) || 0), 0)
  const groups = SOURCE_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    rows: [],
    requests: 0,
    tokens: 0,
    share: 0
  }))
  const groupOfKind = new Map()
  for (const [index, group] of SOURCE_GROUPS.entries()) {
    for (const kind of group.kinds) groupOfKind.set(kind, groups[index])
  }
  let other = null
  for (const row of list) {
    let group = groupOfKind.get(row.kind)
    if (!group) {
      // 将来多一类来源时先落进「其它」，而不是从表里凭空消失。
      other ||= { key: 'other', label: '其它', rows: [], requests: 0, tokens: 0, share: 0 }
      group = other
    }
    const title = sourceTitle(row, pluginNames)
    group.rows.push({
      ...row,
      title,
      detail: sourceDetail(row, title),
      color: USAGE_KIND_COLORS[row.kind] || 'var(--color-fg-muted)'
    })
    group.requests += Number(row.requests) || 0
    group.tokens += Number(row.totalTokens) || 0
  }
  const used = [...groups, ...(other ? [other] : [])]
    .filter((group) => group.rows.length > 0)
    .map((group) => ({
      ...group,
      rows: group.rows.sort(
        (a, b) =>
          (Number(b.totalTokens) || 0) - (Number(a.totalTokens) || 0) || a.id.localeCompare(b.id)
      ),
      share: total > 0 ? group.tokens / total : 0
    }))
  return { total, groups: used }
}
