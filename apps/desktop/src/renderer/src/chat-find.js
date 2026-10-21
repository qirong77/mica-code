/**
 * 主对话区的查找（Cmd/Ctrl+F，VS Code 的 find widget）。
 *
 * 这里只放纯逻辑：把查找框里的文本编译成匹配器、在一段文本里扫命中、命中序号推进、
 * 结果计数文案。DOM 扫描 / 高亮 / 滚动在 ChatFind.jsx——那些必须看真实文档，而「命中
 * 从哪儿算起」这类规则放在这边才能被单测锁住。
 */

/** 单次查找最多收集的命中数：再多也没人会一条条翻，高亮上千条 Range 只会拖慢滚动。 */
export const FIND_MATCH_LIMIT = 1000

/** 全字匹配用的「字」定义：与 VS Code 的 \b 同口径（ASCII 字母、数字、下划线）。 */
const WORD_CHARS = 'A-Za-z0-9_'

const SPECIALS = /[.*+?^${}()|[\]\\]/g

/** 把字面量查询里的正则元字符转义掉——用户输入 `a.b` 不该匹配 `axb`。 */
export function escapeFindText(text) {
  return String(text ?? '').replace(SPECIALS, '\\$&')
}

/**
 * 编译查找条件。
 *
 * 返回 `{ query, error, pattern }`：空查询返回 null（查找条还在、只是没有条件）；正则写坏
 * 时 `error` 是给用户看的一句话，`pattern` 为 null。`pattern` 带 `g`，调用方每次扫描自己
 * 复制一份，别共用同一个 lastIndex。
 */
export function compileFindMatcher(query, options = {}) {
  const raw = String(query ?? '')
  if (!raw) return null
  const { caseSensitive = false, wholeWord = false, regex = false } = options
  const body = regex ? raw : escapeFindText(raw)
  // 不用 `u`：它会让一部分用户写得没错的老正则（如 `[\w-]` 之外的花样）突然变成非法。
  const flags = caseSensitive ? 'g' : 'gi'
  const source = wholeWord ? `(?<![${WORD_CHARS}])(?:${body})(?![${WORD_CHARS}])` : body
  try {
    return { query: raw, error: '', pattern: new RegExp(source, flags) }
  } catch {
    return { query: raw, error: '正则无效', pattern: null }
  }
}

/**
 * 在一段文本里找出全部命中，返回 `{ matches: [{ start, end }], truncated }`。
 *
 * 零宽命中（`a*`、`^` 这种）直接跳过：高亮一条零宽度 Range 看不见，只会白白吃满上限；
 * 跳过时仍要把 lastIndex 往前推，否则 exec 会原地打转。
 */
export function findTextMatches(text, matcher, limit = FIND_MATCH_LIMIT) {
  const empty = { matches: [], truncated: false }
  const source = String(text ?? '')
  if (!source || !matcher?.pattern || limit <= 0) return empty
  const pattern = new RegExp(matcher.pattern.source, matcher.pattern.flags)
  const matches = []
  let truncated = false
  let match = pattern.exec(source)
  while (match) {
    if (!match[0]) {
      pattern.lastIndex = match.index + 1
      if (pattern.lastIndex > source.length) break
      match = pattern.exec(source)
      continue
    }
    if (matches.length >= limit) {
      truncated = true
      break
    }
    matches.push({ start: match.index, end: match.index + match[0].length })
    match = pattern.exec(source)
  }
  return { matches, truncated }
}

/** 命中序号推进（首尾循环）：`index` 为 -1 表示还没选中过。 */
export function stepMatchIndex(index, delta, count) {
  if (count <= 0) return -1
  if (index < 0) return delta >= 0 ? 0 : count - 1
  return (((index + delta) % count) + count) % count
}

/** 查找条右侧的结果文案：空查询不占位，无命中明确说「无结果」，命中给 n/总数。 */
export function findCountLabel({
  index = -1,
  count = 0,
  truncated = false,
  error = '',
  query = ''
}) {
  if (error) return error
  if (!String(query ?? '')) return ''
  if (count <= 0) return '无结果'
  return `${index + 1}/${count}${truncated ? '+' : ''}`
}
