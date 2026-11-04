// 「By source」表的纯数据层：把每一条来源聚成「插件（父级）→ 它底下的具体条目」两层树，
// 并定下显示名与副标题。命名与排序收在这里，表只负责画，便于单测。
//
// 这一层回答的是「这笔请求是谁发起的」。所有请求都要经过 App，但发起者不同：主对话、
// 某个插件（起标题、压缩摘要、整理记忆、旁问）、主对话派出去的子代理（类型由 subagent
// 插件提供）。只摊成一串 `Implementer` / `compact` 时，用户看不出这些名字从哪来，也看不出
// 同一个功能为什么会有两行。所以按插件归组：父行是插件，子行是它触发的具体请求。
//
// **名字一律用插件自己的**：父行取清单里的 `name`（`By The Way`，不是「旁问」），子行用
// 记账里原样的 id / 类型名（`Explore`、`btw`）。这里不翻译也不起别名——同一个东西在插件
// 页、日志与统计页叫三个名字时，用户对不上账。
import { USAGE_KIND_COLORS } from './usage-series'
import { USAGE_SOURCE_LABELS } from '@packages/mica-web-shared/usage-source.js'

/** 每行标出的「谁花的」。父行只有三类：主对话 / 插件 / 内核。 */
export const SOURCE_KIND_LABELS = USAGE_SOURCE_LABELS

/** 卡片底部那行图例：四类来源分别是什么，以及什么时候会出现。 */
export const SOURCE_KIND_HINTS = {
  main: '这条会话自己的请求：每轮对话、每次工具迭代各算一次',
  delegation: '主对话用 agent 工具派出去的子代理，类型由 subagent 插件提供',
  plugin: '插件自己发的请求：起标题、压缩摘要、记忆整理、旁问……',
  helper: '内核自带命令发的请求（/compact、mica compact），不经过插件'
}

const MAIN_GROUP = 'main'
/** 没有插件可归属的那一组标题：内核自带的命令。 */
const CORE_TITLE = '内核'

/** 一行的聚合键：同一个功能只占一行，其它来源按自己的 id 分开。 */
export function sourceRowKey(row) {
  return `${row?.kind}:${row?.id}`
}

/**
 * 一行的显示名：插件用清单里的名字（找不到——已卸载——就退回 id），其余原样用记账里的 id。
 */
export function sourceTitle(row, pluginNames) {
  if (row.kind === 'main') return USAGE_SOURCE_LABELS.main
  const name = pluginNames?.get?.(row.id)
  if (name) return name
  return row.id || USAGE_SOURCE_LABELS[row.kind] || row.kind
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
 * 一行的副标题：谁派发、会话数 / 任务数、用途。
 *
 * 委派行的用途是每个任务的 prompt 摘要（十几个任务拼起来就是一大段），所以只取第一条
 * 并标出还有几条。
 */
export function sourceDetail(row) {
  const parts = []
  if (row.kind === 'delegation') {
    parts.push('经 agent 工具派出')
    if (row.tasks > 0) parts.push(countLabel(row.tasks, 'task'))
    return parts.join(' · ')
  }
  if (row.sessions > 0) parts.push(countLabel(row.sessions, 'session'))
  const purpose = purposeText(row.purposes)
  if (purpose) parts.push(purpose)
  return parts.join(' · ')
}

/** `1 session` / `2 sessions`：副标题是给人读的一句话，不该出现「1 sessions」。 */
function countLabel(count, noun) {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`
}

/**
 * 一行归到哪个插件（父级）：
 *
 * - 主对话自成一组，它就是 App 自己；
 * - 插件自己的请求（`kind === 'plugin'`）归到它自己；
 * - 子代理与插件后台请求归到记账里的 `pluginId`——那是发起它的插件，老记录由
 *   `evolution` 的 `usage-source-owner` 迁移补齐；
 * - 没有 `pluginId` 的只剩内核自带命令（`/compact`、`mica compact`），按功能 id 自成一组。
 */
export function sourceGroupOf(row, pluginNames) {
  if (row.kind === 'main') {
    return {
      key: MAIN_GROUP,
      title: USAGE_SOURCE_LABELS.main,
      pluginId: null,
      kind: 'main',
      selfId: row.id
    }
  }
  const ownerId = row.kind === 'plugin' ? row.id : row.pluginId || null
  if (ownerId) {
    return {
      key: `plugin:${ownerId}`,
      title: pluginNames?.get?.(ownerId) || ownerId,
      pluginId: ownerId,
      kind: 'plugin',
      selfId: ownerId
    }
  }
  if (row.kind === 'delegation') {
    // 迁移之后不该再出现；真出现时（用户插件注册的类型、迁移名单之外）仍按委派呈现，
    // 不硬塞给某个插件。
    return {
      key: 'delegation',
      title: USAGE_SOURCE_LABELS.delegation,
      pluginId: null,
      kind: 'delegation',
      selfId: null
    }
  }
  return {
    key: `core:${row.id}`,
    title: row.id || CORE_TITLE,
    pluginId: null,
    kind: 'helper',
    selfId: row.id
  }
}

/** 可排序的指标：Share 就是 token 总量，与父行的占比条同源。 */
const SORT_VALUE = {
  requests: (row) => row.requests,
  input: (row) => row.inputTokens,
  output: (row) => row.outputTokens,
  share: (row) => row.totalTokens
}

const DEFAULT_SORT = { key: 'share', desc: true }

function sumField(members, field) {
  return members.reduce((total, row) => total + (Number(row[field]) || 0), 0)
}

/**
 * 并进父行的成员：id 与父行同一个的那些（插件自己的请求；`btw` 的旁问线程挂在
 * `By The Way` 下，功能 id 就等于插件 id；内核命令的 `compact` 也是同一条）。
 */
function selfRowsOf(group, members) {
  if (!group.selfId) return []
  return members.filter((row) => row.id === group.selfId)
}

/**
 * 组内成员合成一个父行：父行数字是整组之和（插件自身请求 + 它触发的子项），卡片总量只累
 * 父行，展开成子行时不会重复计数。
 */
function groupRow(group, members, { pluginDescriptions, total, value, desc }) {
  const self = selfRowsOf(group, members)
  const children = members.filter((row) => !self.includes(row))
  const totalTokens = sumField(members, 'totalTokens')
  return {
    key: `group:${group.key}`,
    kind: group.kind,
    id: group.pluginId || group.key,
    pluginId: group.pluginId,
    title: group.title,
    detail: groupDetail({ group, members, children, pluginDescriptions }),
    // 父行的类型就是「谁发起的」：主对话 / 插件 / 子代理 / 内核。内核组不写「内核后台」，
    // 那会和父行标题重复一遍。
    kindLabel:
      group.kind === 'main'
        ? USAGE_SOURCE_LABELS.main
        : group.kind === 'plugin'
          ? USAGE_SOURCE_LABELS.plugin
          : group.kind === 'delegation'
            ? USAGE_SOURCE_LABELS.delegation
            : CORE_TITLE,
    kindHint: SOURCE_KIND_HINTS[group.kind],
    color: USAGE_KIND_COLORS[group.kind] || 'var(--color-fg-muted)',
    share: total > 0 ? totalTokens / total : 0,
    requests: sumField(members, 'requests'),
    inputTokens: sumField(members, 'inputTokens'),
    outputTokens: sumField(members, 'outputTokens'),
    totalTokens,
    sessions: sumField(members, 'sessions'),
    depth: 0,
    isGroup: true,
    childCount: children.length,
    children: children
      .slice()
      .sort(
        (a, b) =>
          (desc ? value(b) - value(a) : value(a) - value(b)) || String(a.id).localeCompare(b.id)
      )
  }
}

function groupDetail({ group, members, children, pluginDescriptions }) {
  const parts = []
  const childrenText = children.length > 0 ? `${children.length} 个子项` : ''
  if (group.kind === 'main') {
    const sessions = sumField(members, 'sessions')
    if (sessions > 0) parts.push(countLabel(sessions, 'session'))
    return parts.join(' · ')
  }
  if (group.kind === 'plugin') {
    // 插件身份（原始 id）比描述更稳：描述会改，id 是记账与清单共用的那个键。
    if (group.pluginId !== group.title) parts.push(group.pluginId)
    const sessions = sumField(members, 'sessions')
    if (sessions > 0) parts.push(countLabel(sessions, 'session'))
    if (childrenText) parts.push(childrenText)
    const description = pluginDescriptions?.get?.(group.pluginId)
    if (description) parts.push(purposeText([description]))
    return parts.join(' · ')
  }
  if (group.kind === 'delegation') {
    if (childrenText) parts.push(childrenText)
    return parts.join(' · ')
  }
  // 内核自带命令：它不属于任何插件，Type 列已经写着「内核」，不必再解释一遍。
  parts.push('内建命令')
  if (childrenText) parts.push(childrenText)
  return parts.join(' · ')
}

/** 子项：带上显示名与副标题，深度为 1，表里缩进一层。 */
function childRow(row, { pluginNames, total }) {
  const title = sourceTitle(row, pluginNames)
  return {
    ...row,
    title,
    detail: sourceDetail(row),
    kindLabel: USAGE_SOURCE_LABELS[row.kind] || row.kind,
    kindHint: SOURCE_KIND_HINTS[row.kind] || '',
    color: USAGE_KIND_COLORS[row.kind] || 'var(--color-fg-muted)',
    share: total > 0 ? (Number(row.totalTokens) || 0) / total : 0,
    depth: 1,
    isGroup: false,
    childCount: 0
  }
}

function groupRank(row) {
  if (row.kind === 'main') return 0
  // 内核自带命令排最后；插件与子代理按各自总量依次往下。
  return row.kind === 'helper' ? 2 : 1
}

/**
 * 把聚合好的来源行排成两层树：父行是插件，紧跟它的子项。
 *
 * 组间顺序固定为「主对话 → 各插件（按组总量）→ 内核」：App 自己的开销永远排第一，
 * 再按哪个插件花得多依次往下。指标排序只作用在组内子项（分组是结构，不是排序）。
 *
 * `pluginNames` / `pluginDescriptions` 是 `Map<pluginId, string>`，来自配置页那份插件清单：
 * 显示名与描述属于清单，不在这里写死——用户插件与官方插件、装过又卸掉的插件都走同一条路。
 */
export function flattenSourceRows(
  rows,
  { pluginNames, pluginDescriptions, sort = DEFAULT_SORT } = {}
) {
  const list = rows || []
  const total = list.reduce((sum, row) => sum + (Number(row.totalTokens) || 0), 0)
  const groups = new Map()
  for (const row of list) {
    const group = sourceGroupOf(row, pluginNames)
    const entry = groups.get(group.key) || { ...group, members: [] }
    entry.members.push(row)
    groups.set(group.key, entry)
  }

  const value = SORT_VALUE[sort?.key] || SORT_VALUE.share
  const desc = sort?.desc !== false
  const parents = [...groups.values()]
    .map((group) => groupRow(group, group.members, { pluginDescriptions, total, value, desc }))
    .sort(
      (a, b) =>
        groupRank(a) - groupRank(b) ||
        b.totalTokens - a.totalTokens ||
        a.title.localeCompare(b.title)
    )

  const flattened = []
  for (const parent of parents) {
    const { children, ...rest } = parent
    flattened.push(rest)
    for (const child of children) flattened.push(childRow(child, { pluginNames, total }))
  }
  // 父行永远是组内第一行，指标只决定它底下子项的顺序。
  return { total, rows: flattened, groups: groups.size }
}
