/**
 * 输入框补全的纯逻辑（`@` 文件 / `/` skill）。
 *
 * `@` 文件补全完全交给 `mica-file-mentions`（CLI 输入框与 file-mention 插件引用同一份，
 * 见该包 README）：触发判定、候选、排序、数量和插入文本都取自那个包，桌面端只负责把 host
 * 返回的候选映射成浮层需要的形状。`/` skill 是桌面端独有的入口（CLI 的 `/` 是命令面板），
 * 它的触发、排序与替换逻辑留在这里。
 *
 * 两个触发字符都只往输入框插入文本，不执行任何动作。
 */
import {
  MAX_FILE_MENTION_RESULTS,
  activeFileMention,
  mentionText
} from '@packages/mica-file-mentions/rank.js'

// skill 的数量天然有限（host 侧最多扫 200 条），列表自己会滚，所以这里不截断成十来个：
// 用户按 `/` 是想浏览或按关键字挑一个，藏掉大半候选就只能靠记名字了。
export const SKILL_COMPLETION_LIMIT = 200
export const FILE_COMPLETION_LIMIT = MAX_FILE_MENTION_RESULTS
// 与 CLI 一致：有查询时挡 100ms 的连续击键，空查询立即给出工作区文件（扫描结果在
// host 侧按工作区缓存，所以这一下不会重新遍历目录）。
export const FILE_COMPLETION_DEBOUNCE_MS = 100

/**
 * 候选来源标记的取值。浮层按它给那枚小标记上不同颜色，未知取值一律不显示——
 * 来源是宿主给的提示，猜不出来就当没有，不编一个。
 */
export const COMPLETION_SOURCE_KINDS = ['builtin', 'plugin', 'project', 'user', 'config']

/**
 * 光标前是否正处在一个补全触发里；是则返回 `{ kind, start, query }`。
 *
 * `/`：**自己在词首**（文本开头或空白之后）且到光标之间没有空白/斜杠，所以 `/` 不必在
 * 行首（`看下 /co` 也补全），而 `and/or`、`src/a/b.ts` 这种更像路径的写法不触发。
 * `@`：词首（文本开头、空白、开括号/引号或非 ASCII 字符之后），`mail@x.com` 不触发。
 * 两者互斥，先判 `/`。
 */
export function activeCompletion(value, caret) {
  const text = String(value ?? '')
  const end = Number.isFinite(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length
  const before = text.slice(0, end)

  const slash = /(^|\s)\/([^\s/]*)$/.exec(before)
  if (slash) return { kind: 'skill', start: slash.index + slash[1].length, query: slash[2] }

  const file = activeFileMention(text, end)
  if (file) return { kind: 'file', start: file.start, query: file.query }
  return null
}

export function completionInsertText(item) {
  if (!item) return ''
  if (item.kind === 'skill' || item.kind === 'mcp') {
    // `path` 是浮层选项上的统一字段；host 的原始候选里 MCP 叫 `url`。
    return completionLink(item.kind, item.name, item.path || item.url)
  }
  return mentionText(item.path ?? item.name)
}

/**
 * 插入的是一枚 markdown 链接：方括号里是「哪一类 + 叫什么」，圆括号里是它能点开的位置。
 *
 * 只写类型（`[mcp](…)`）在输入框里认不出是哪一台 server，而这段文本首先是给人看的；
 * 类型仍留在最前面，滑一眼扫下来就知道插的是 skill 还是 MCP。位置对 skill 是 `SKILL.md`
 * 的绝对路径（点开就是完整说明），对 MCP 是它的接口地址，stdio 的 server 没有地址，
 * 退回配置文件——否则只能插一枚点了没反应的空链接。
 */
function completionLink(kind, name, target) {
  const trimmed = String(name ?? '').trim()
  const label = trimmed ? `${kind}:${trimmed}` : kind
  const value = String(target ?? '').trim()
  // 没有可打开的位置时只留名字：编一个目标只会得到一枚点了没反应的链接。
  if (!value) return `[${label}] `
  return `[${label}](${linkDestination(value)}) `
}

/**
 * markdown 链接目标里不能直接出现空白与括号，否则整条链接解析不成立（`[skill](/a b/x)`
 * 的目的地只剩 `/a`）。含这些字符时用 `<…>` 包住——CommonMark 允许这么写，目标里留的
 * 还是真实路径：**这一点比格式好看更要紧**，模型读到的就是 `/a b/x`，不用先解一遍
 * 百分号编码再拼回去。
 */
function linkDestination(value) {
  if (!/[\s()]/.test(value)) return value
  // 尖括号内部不能再有 `<>`，否则解析在它那里就断了；这两个字符在路径里也罕见。
  return `<${value.replace(/[<>]/g, (char) => encodeURIComponent(char))}>`
}

/** host 的 mention 候选 → 浮层选项：`label` 是文件名，`description` 是工作区相对路径。 */
export function fileCompletionOptions(items, limit = FILE_COMPLETION_LIMIT) {
  const list = Array.isArray(items) ? items : []
  return list.slice(0, limit).map((item) => {
    const path = String(item?.path ?? '')
    return {
      key: `file:${path}`,
      kind: 'file',
      name: path,
      path,
      label: String(item?.label ?? path),
      description: String(item?.description ?? ''),
      highlights: Array.isArray(item?.labelHighlights) ? item.labelHighlights : []
    }
  })
}

/** 某个查询在一段文本里出现的全部字符下标（大小写不敏感，用于高亮）。 */
export function matchIndexes(text, query) {
  const source = String(text ?? '').toLocaleLowerCase()
  const needle = String(query ?? '').toLocaleLowerCase()
  const indexes = []
  if (!needle) return indexes
  let from = source.indexOf(needle)
  while (from >= 0) {
    for (let offset = 0; offset < needle.length; offset += 1) indexes.push(from + offset)
    from = source.indexOf(needle, from + needle.length)
  }
  return indexes
}

/**
 * skill 候选排序：名称完全匹配 > 名称前缀 > 名称子串 > 只在说明里命中，同档按原顺序。
 *
 * 说明也参与匹配：skill 的名字往往很短（`/am`、`/am-cfg`），用户记住的多半是「这个 skill
 * 干什么」，只按名字过滤等于把搜索废掉。
 */
export function rankCompletions(items, query, limit = SKILL_COMPLETION_LIMIT) {
  const list = Array.isArray(items) ? items : []
  const q = String(query ?? '').toLowerCase()
  if (!q) return list.slice(0, limit)

  const scored = []
  list.forEach((item, index) => {
    const target = String(item?.name ?? '').toLowerCase()
    const description = String(item?.description ?? '').toLowerCase()
    // 来源标记也参与匹配：用户会按「插件」两个字找插件带来的那些。
    const source = String(item?.sourceLabel ?? '').toLowerCase()
    let rank = -1
    if (target === q) rank = 0
    else if (target.startsWith(q)) rank = 1
    else if (target.includes(q)) rank = 2
    else if (description.includes(q)) rank = 3
    else if (source.includes(q)) rank = 4
    if (rank >= 0) scored.push({ item, rank, index })
  })
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return scored.slice(0, limit).map((entry) => entry.item)
}

/** host 的 skill 候选 → 浮层选项：名称带 `/` 前缀，名称与说明里命中查询的字符都标出来。 */
export function skillCompletionOptions(items, query, limit = SKILL_COMPLETION_LIMIT) {
  const skills = Array.isArray(items) ? items : []
  return rankCompletions(skills, query, limit).map((skill) => skillOption(skill, query))
}

/**
 * `/` 浮层的完整候选：skill 与 MCP server 混在一起排序。
 *
 * 两边都是「往输入框里插一段指向某个能力的文本」，用户按 `/` 时并不想先决定是哪一类，
 * 所以不分组、按同一套评分（完全匹配 → 前缀 → 包含 → 只在说明里命中）排。
 */
export function slashCompletionOptions(
  { skills, mcpServers } = {},
  query,
  limit = SKILL_COMPLETION_LIMIT
) {
  const entries = [
    ...(Array.isArray(skills) ? skills : []).map((skill) => ({
      kind: 'skill',
      item: skill,
      name: String(skill?.name ?? ''),
      description: skillDescription(skill),
      sourceLabel: sourceOf(skill)?.label ?? ''
    })),
    ...(Array.isArray(mcpServers) ? mcpServers : []).map((server) => ({
      kind: 'mcp',
      item: server,
      name: String(server?.name ?? ''),
      description: mcpDescription(server),
      sourceLabel: sourceOf(server)?.label ?? ''
    }))
  ]
  const ranked = rankCompletions(entries, query, limit)
  return ranked.map((entry) =>
    entry.kind === 'mcp' ? mcpOption(entry.item, query) : skillOption(entry.item, query)
  )
}

/**
 * 一条候选的来源标记。
 *
 * 宿主给的是 `{ kind, label, detail? }`；`kind` 不在白名单里（宿主升级、字段写错）时整条
 * 丢掉，而不是在界面上画一个看不懂的标记。`detail` 是悬停时看的完整位置（SKILL.md 路径、
 * config.json 路径、插件 id）。
 */
function sourceOf(item) {
  const raw = item?.source
  if (!raw || typeof raw !== 'object') return null
  const kind = String(raw.kind ?? '')
  const label = String(raw.label ?? '').trim()
  if (!label || !COMPLETION_SOURCE_KINDS.includes(kind)) return null
  const detail = String(raw.detail ?? '').trim()
  return { kind, label, ...(detail ? { detail } : {}) }
}

function skillOption(skill, query) {
  const name = String(skill?.name ?? '')
  const description = skillDescription(skill)
  const source = sourceOf(skill)
  return {
    key: `skill:${name}`,
    kind: 'skill',
    name,
    path: String(skill?.path ?? ''),
    label: `/${name}`,
    description,
    ...(source ? { source, sourceLabel: source.label } : {}),
    // label 前面多了一个 `/`，名称里的下标整体右移一位
    highlights: matchIndexes(name, query).map((index) => index + 1),
    descriptionHighlights: matchIndexes(description, query)
  }
}

/**
 * skill 候选的说明列。
 *
 * 来源不写在这里：它有自己的标记列（`source`），混进说明里会把「这个 skill 干什么」
 * 挤到后面，而两者都不是同一个问题的答案。
 */
function skillDescription(skill) {
  return String(skill?.description ?? '')
}

/** MCP 候选的说明列：工具名（未知时给连接方式），同时也是查询匹配的文本。 */
function mcpDescription(server) {
  const tools = Array.isArray(server?.tools) ? server.tools.filter(Boolean) : []
  if (tools.length) return `工具：${tools.join('、')}`
  return server?.type === 'stdio' ? '本地进程' : 'HTTP'
}

/** MCP 候选：label 带 `mcp:` 前缀，说明里是工具名（未知时给连接方式）。 */
function mcpOption(server, query) {
  const name = String(server?.name ?? '')
  const tools = Array.isArray(server?.tools) ? server.tools.filter(Boolean) : []
  const description = mcpDescription(server)
  const source = sourceOf(server)
  const label = `mcp:${name}`
  return {
    key: `mcp:${name}`,
    kind: 'mcp',
    name,
    // 与 skill 的 `path` 同一含义：这个 server 能点开的位置。http 的是接口地址，
    // stdio 没有地址，退回配置文件（`source.detail` 就是它的路径）。
    path: String(server?.url ?? '') || String(source?.detail ?? ''),
    tools,
    label,
    description,
    ...(source ? { source, sourceLabel: source.label } : {}),
    // label 前面多了 `mcp:` 四个字符，名称里的下标整体右移
    highlights: matchIndexes(name, query).map((index) => index + 'mcp:'.length),
    descriptionHighlights: matchIndexes(description, query)
  }
}

/** 把光标前那段 `@query` / `/query` 整体替换成候选的插入文本。 */
export function applyCompletion(value, caret, start, insertText) {
  const text = String(value ?? '')
  const end = Number.isFinite(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length
  const from = Number.isFinite(start) ? Math.max(0, Math.min(start, end)) : end
  return {
    text: text.slice(0, from) + insertText + text.slice(end),
    caret: from + insertText.length
  }
}
