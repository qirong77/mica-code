/**
 * 快速压缩折叠说明的界面投影。
 *
 * 压缩会把「工具结果已全部清空的轮次」折成一条助手文本：
 * `[tool calls cleared during compact: read_file(a.ts), run_shell(cd x)]`。
 * 这段话是给模型看的（提醒它这些结果已经不在了），逐条当助手消息渲染会在对话里
 * 排成一堵墙：每条都带 `●`、都带截断的绝对路径，读不出任何有用信息。
 *
 * 这里把历史里连续的说明收成一行摘要：清理了几轮、涉及哪些工具；原始说明留在
 * `detail` 里当悬停提示，不丢信息。
 */

/** 与 packages/mica-context 的 TOOL_ROUND_FOLD_PREFIX 一致。 */
export const COMPACT_TOOL_NOTE_PREFIX = '[tool calls cleared during compact:'

/** 一条说明只列前几次调用，剩下的写成 `+N`；与压缩侧的 FOLD_NOTE_MAX_CALLS 对应。 */
const SUMMARY_MAX_TOOLS = 5

/** 悬停提示的长度上限：几十条说明拼起来不该变成一个巨型 tooltip。 */
const DETAIL_MAX_CHARS = 600

/** 按括号深度切分条目：`run_shell(cd /x, ls)` 里的逗号不是分隔符。 */
function noteEntries(body) {
  const entries = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) {
      entries.push(body.slice(start, index))
      start = index + 1
    }
  }
  entries.push(body.slice(start))
  return entries.map((entry) => entry.trim()).filter(Boolean)
}

/** 整段文本就是一条折叠说明时返回解析结果，否则返回 null。 */
export function parseCompactToolNote(text) {
  const value = String(text ?? '').trim()
  if (!value.startsWith(COMPACT_TOOL_NOTE_PREFIX) || !value.endsWith(']')) return null
  const body = value.slice(COMPACT_TOOL_NOTE_PREFIX.length, -1).trim()
  const tools = []
  let omitted = 0
  for (const entry of noteEntries(body)) {
    const rest = /^\+(\d+)$/.exec(entry)
    if (rest) {
      omitted += Number(rest[1]) || 0
      continue
    }
    const paren = entry.indexOf('(')
    const name = (paren > 0 ? entry.slice(0, paren) : entry).trim()
    tools.push(name || 'unknown')
  }
  return { tools, omitted, raw: value }
}

/**
 * 把文本结尾的折叠说明切出来。
 *
 * 有助手正文的轮次会把说明追加在正文后面（`正文\n\n[说明]`），这种消息保留正文、
 * 只把说明的部分拿去汇总。
 */
export function splitTrailingCompactNotes(text) {
  const original = String(text ?? '')
  let body = original
  const notes = []
  while (true) {
    const trimmed = body.replace(/\s+$/, '')
    const start = trimmed.lastIndexOf(COMPACT_TOOL_NOTE_PREFIX)
    if (start < 0) break
    // 说明只可能独立成段（折叠时用空行接在正文后面），或是整条消息的全部内容。
    // 正文里引用这段格式（比如在代码块里讲它长什么样）不能当成说明剥掉。
    if (start > 0 && !trimmed.slice(0, start).endsWith('\n\n')) break
    const note = parseCompactToolNote(trimmed.slice(start))
    if (!note) break
    notes.unshift(note)
    body = trimmed.slice(0, start)
  }
  if (notes.length === 0) return { body: original, notes }
  return { body: body.replace(/\s+$/, ''), notes }
}

/** 一句摘要：`已清理 12 轮工具调用 · read_file ×8、run_shell ×4`。 */
export function summarizeCompactToolNotes(notes) {
  const counts = new Map()
  let omitted = 0
  for (const note of notes) {
    for (const name of note.tools) counts.set(name, (counts.get(name) ?? 0) + 1)
    omitted += note.omitted
  }
  const listed = [...counts.entries()].slice(0, SUMMARY_MAX_TOOLS).map(([name, count]) => (
    count > 1 ? `${name} ×${count}` : name
  ))
  if (counts.size > listed.length) listed.push(`等 ${counts.size} 种`)
  if (omitted > 0) listed.push(`另 ${omitted} 次`)
  const head = `已清理 ${notes.length} 轮工具调用`
  return listed.length > 0 ? `${head} · ${listed.join('、')}` : head
}

/**
 * 历史消息 → 对话消息：连续的折叠说明并成一条 `compactNote`。
 *
 * 只在连续的说明之间合并：中间隔着用户消息或助手正文时各自成行，顺序不变。
 */
export function collapseCompactToolNotes(messages, key = 'history') {
  const result = []
  let pending = []
  const flush = () => {
    if (pending.length === 0) return
    const detail = pending.map((note) => note.raw).join('\n')
    result.push({
      id: `history-${key}-compact-${result.length}`,
      kind: 'message',
      role: 'assistant',
      text: summarizeCompactToolNotes(pending),
      detail: detail.length > DETAIL_MAX_CHARS ? `${detail.slice(0, DETAIL_MAX_CHARS)}…` : detail,
      compactNote: true,
      done: true
    })
    pending = []
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    const split = message?.kind === 'message' && message.role === 'assistant' && typeof message.text === 'string'
      ? splitTrailingCompactNotes(message.text)
      : null
    if (!split || split.notes.length === 0) {
      flush()
      result.push(message)
      continue
    }
    if (split.body.trim()) {
      flush()
      result.push({ ...message, text: split.body })
    }
    pending.push(...split.notes)
  }
  flush()
  return result
}
