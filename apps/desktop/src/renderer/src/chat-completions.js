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
  mentionPath,
  mentionText
} from '@packages/mica-file-mentions/rank.js'

export const SKILL_COMPLETION_LIMIT = 8
export const FILE_COMPLETION_LIMIT = MAX_FILE_MENTION_RESULTS
// 与 CLI 一致：有查询时挡 100ms 的连续击键，空查询立即给出工作区文件（扫描结果在
// host 侧按工作区缓存，所以这一下不会重新遍历目录）。
export const FILE_COMPLETION_DEBOUNCE_MS = 100

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

/** 与 CLI 的 mention 一致：路径含空白或引号时整条 JSON 化，避免被拆成两个词。 */
export function completionMentionPath(path) {
  return mentionPath(path)
}

export function completionInsertText(item) {
  if (!item) return ''
  return item.kind === 'skill' ? `/${item.name} ` : mentionText(item.path ?? item.name)
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

/** skill 候选排序：完全匹配 > 前缀 > 子串，其余按原顺序。 */
export function rankCompletions(items, query, limit = SKILL_COMPLETION_LIMIT) {
  const list = Array.isArray(items) ? items : []
  const q = String(query ?? '').toLowerCase()
  if (!q) return list.slice(0, limit)

  const scored = []
  list.forEach((item, index) => {
    const target = String(item?.name ?? '').toLowerCase()
    let rank = -1
    if (target === q) rank = 0
    else if (target.startsWith(q)) rank = 1
    else if (target.includes(q)) rank = 2
    if (rank >= 0) scored.push({ item, rank, index })
  })
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return scored.slice(0, limit).map((entry) => entry.item)
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
