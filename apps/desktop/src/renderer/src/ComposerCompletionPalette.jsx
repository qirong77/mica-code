import { useEffect, useRef } from 'react'
import { IconCommand } from '@tabler/icons-react'

/**
 * 输入框上方的补全候选浮层（`@` 文件 / `/` skill）。
 *
 * 只负责展示与选中回调，选中后怎么改写输入框由 ChatView 决定——这里不执行任何动作。
 * 两种补全都是紧凑的单行：`/` 的能力行在最前面多一枚类型图标（S / M / P），来源写成
 * `mica · plugin · computer-use` 这种三段的一枚标记——一行放得下「叫什么、干什么、哪来的」，
 * 一屏能扫十几条；说明被截成一行，全文在悬停提示里。
 * 名称与说明里命中查询的字符都会高亮（`highlights` / `descriptionHighlights` 是下标数组）。
 *
 * 滚动只发生在候选列表（`.chat-command-palette-body`）上：标题行与键位提示固定在顶部，
 * 键盘上下移动时由这里把当前卡片滚进视野，鼠标滚轮照常可用。
 */
export default function ComposerCompletionPalette({
  title,
  options,
  activeIndex,
  onActiveIndex,
  onSelect,
  emptyText,
  filter,
  onFilter
}) {
  const bodyRef = useRef(null)
  const items = options || []
  const isCapabilities = Boolean(onFilter)

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const row = body.querySelector('[aria-selected="true"]')
    if (!row) return
    // 自己算偏移而不调 scrollIntoView：后者会连带滚动祖先（对话区、窗口），浮层只该动自己的列表
    const box = body.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    if (rect.top < box.top) body.scrollTop -= box.top - rect.top
    else if (rect.bottom > box.bottom) body.scrollTop += rect.bottom - box.bottom
  }, [activeIndex, items.length])

  return (
    <div
      className={`chat-command-palette chat-completion-palette${isCapabilities ? ' is-capabilities' : ''}`}
    >
      <div className="chat-command-palette-title">
        <IconCommand size={12} /> {title}
        {items.length > 0 && <span className="chat-command-palette-count">{items.length} 项</span>}
        {onFilter && (
          <div className="chat-completion-filters" aria-label="补全类型筛选">
            {[
              ['skill', 'skill'],
              ['mcp', 'MCP'],
              ['prompt', 'plugins']
            ].map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                aria-pressed={filter === kind}
                className={filter === kind ? 'is-active' : ''}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onFilter(filter === kind ? null : kind)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <span>↑↓ 选择 · Enter/Tab 插入 · Esc 关闭</span>
      </div>
      <div ref={bodyRef} className="chat-command-palette-body" role="listbox" aria-label={title}>
        {items.length === 0 && <div className="chat-select-empty">{emptyText}</div>}
        {items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? 'chat-command-active' : ''}
            // 悬停给出处：skill 是 SKILL.md 的绝对路径（插入的也是它），MCP 是配置位置
            title={completionTitle(item)}
            onMouseEnter={() => onActiveIndex(index)}
            // 按下就插入，避免 mousedown 先把焦点从 textarea 拿走
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(item)}
          >
            {isCapabilities && <CompletionKindIcon kind={item.kind} />}
            <HighlightedLabel text={item.label} highlights={item.highlights} />
            <span className="chat-command-description">
              <HighlightedText
                text={item.description || ''}
                highlights={item.descriptionHighlights}
              />
            </span>
            <CompletionKindTag kind={item.kind} />
            {item.sourceText && (
              <span
                className={`chat-command-source is-${item.source.kind}`}
                title={item.source.detail || undefined}
              >
                {item.sourceText}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 候选的类型标记。
 *
 * 只认 `/` 浮层里的三类：skill、MCP server 与插件声明的条目（`prompt`）。`@` 文件补全的
 * `file` 不画标记——那里一整屏都是文件，标一排「file」只是噪声。
 */
// 这三枚说明「这一条是什么」：skill、MCP server、插件声明的一段提示词。来源（`mica · plugin ·`
// 那枚）已经在右边说清归属，这里不必再写一遍 `plugin`；顶部筛选按钮叫 `plugins`，它筛的是
// 「清单声明的条目」这一整类。
const COMPLETION_KIND_LABELS = { skill: 'skill', mcp: 'MCP', prompt: 'prompt' }

const COMPLETION_KIND_MARKS = { skill: 'S', mcp: 'M', prompt: 'P' }

function CompletionKindIcon({ kind }) {
  const mark = COMPLETION_KIND_MARKS[kind] || '·'
  return (
    <span aria-hidden="true" className={`chat-completion-row-icon is-${kind || 'unknown'}`}>
      {mark}
    </span>
  )
}

function CompletionKindTag({ kind }) {
  const label = COMPLETION_KIND_LABELS[kind]
  if (!label) return null
  return <span className={`chat-command-kind is-${kind}`}>{label}</span>
}

/**
 * 悬停提示：说明全文 + 出处（插件 id / 配置文件）+「会插进去的东西」。
 *
 * 行只放得下一行截断的说明，全文在这里补上；后两行与出处各自的 `detail` 相同，所以重复的
 * 那一段不再写第二遍。
 */
function completionTitle(item) {
  const lines = []
  if (item?.description) lines.push(String(item.description))
  if (item?.source?.detail && item.source.detail !== item.path) lines.push(item.source.detail)
  if (item?.path) lines.push(item.path)
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** 把标出的字符包成 `<mark>`，其余原样输出（下标是文本的字符下标）。 */
function HighlightedText({ text, highlights }) {
  const value = String(text ?? '')
  const marked = new Set(
    (Array.isArray(highlights) ? highlights : []).filter(
      (index) => Number.isInteger(index) && index >= 0 && index < value.length
    )
  )
  if (marked.size === 0) return value

  const parts = []
  let buffer = ''
  let bufferMarked = false
  const flush = () => {
    if (!buffer) return
    parts.push(bufferMarked ? <mark key={parts.length}>{buffer}</mark> : buffer)
    buffer = ''
  }
  for (let index = 0; index < value.length; index += 1) {
    const isMarked = marked.has(index)
    if (isMarked !== bufferMarked) {
      flush()
      bufferMarked = isMarked
    }
    buffer += value[index]
  }
  flush()
  return parts
}

/** 名称用等宽字体（`/skill-name` 是输入文本的一部分），高亮规则与说明相同。 */
function HighlightedLabel({ text, highlights }) {
  return (
    <code>
      <HighlightedText text={text} highlights={highlights} />
    </code>
  )
}
