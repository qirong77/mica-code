/**
 * 输入框补全（`@` 文件 / `/` skill）的纯逻辑。
 *
 * 两个触发字符共用一套流程：算出光标前正在补全的那段文本（trigger/query/start），列出候选，
 * 选中后把这段文本整体替换成 insertText。只插入文本、不执行任何动作。
 */

export const COMPLETION_LIMIT = 8
export const FILE_COMPLETION_DEBOUNCE_MS = 220

/**
 * 光标前是否正处在一个补全触发里。
 * - `/` 只在「当前整行就是一条命令且还没有空白」时触发（`/foo bar` 之后不再补全）。
 * - `@` 要求它在词首（行首或空白之后），且到光标之间没有空白，`mail@x.com` 这类不触发。
 * 两个条件互斥，先判 `/`。
 */
export function activeCompletion(value, caret) {
  const text = String(value ?? '')
  const end = Number.isFinite(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length
  const before = text.slice(0, end)

  const lineStart = before.lastIndexOf('\n') + 1
  const line = before.slice(lineStart)
  if (line.startsWith('/') && !/\s/.test(line)) {
    return { kind: 'skill', start: lineStart, query: line.slice(1) }
  }

  const at = /(^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: 'file', start: at.index + at[1].length, query: at[2] }
  return null
}

/** 与 CLI 的 mention 一致：路径含空白或引号时整条 JSON 化，避免被拆成两个词。 */
export function completionMentionPath(path) {
  const value = String(path ?? '')
  return /[\s"]/.test(value) ? JSON.stringify(value) : value
}

export function completionInsertText(item) {
  if (!item) return ''
  return item.kind === 'skill'
    ? `/${item.name} `
    : `@${completionMentionPath(item.path ?? item.name)} `
}

/** 候选排序：完全匹配 > 前缀 > 子串，其余按原顺序。 */
export function rankCompletions(items, query, limit = COMPLETION_LIMIT) {
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
