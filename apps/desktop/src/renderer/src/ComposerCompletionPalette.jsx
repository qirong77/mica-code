import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconCommand } from '@tabler/icons-react'

/**
 * 输入框上方的补全候选浮层（`@` 文件 / `/` skill）。
 *
 * 只负责展示与选中回调，选中后怎么改写输入框由 ChatView 决定——这里不执行任何动作。
 * 两种补全都是紧凑的单行：一行放得下「叫什么、干什么、是哪一类」，一屏能扫十几条；说明被
 * 截成一行，全文与出处（SKILL.md / config.json / 插件 id）在悬停提示里。
 * 名称与说明里命中查询的字符都会高亮（`highlights` / `descriptionHighlights` 是下标数组）。
 *
 * 滚动只发生在候选列表（`.chat-command-palette-body`）上：标题行与键位提示固定在顶部，
 * 键盘上下移动时由这里把当前卡片滚进视野，鼠标滚轮照常可用。
 *
 * `/` 的能力浮层带着筛选 tab，切 tab 时列表会变短——浮层高度因此钉在「量到过的最高内容」
 * 上，不跟着缩（否则每切一次 tab 框体就跳一下）；第一次量到的就是它的默认高度，条目少就矮。
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
  const titleRef = useRef(null)
  const bodyRef = useRef(null)
  const items = options || []
  const isCapabilities = Boolean(onFilter)
  const pinnedHeightRef = useRef(0)
  const [pinnedHeight, setPinnedHeight] = useState(0)

  // 高度只钉在能力浮层上（`@` 文件补全跟着内容走，边打字边收是它该有的样子）。
  // 量的是「内容自己需要多高」：标题行 + 列表的 scrollHeight + 浮层上下 padding。
  useLayoutEffect(() => {
    if (!isCapabilities) return
    const body = bodyRef.current
    const titleRow = titleRef.current
    if (!body || !titleRow) return
    const fit = titleRow.offsetHeight + body.scrollHeight + 6
    if (fit > pinnedHeightRef.current) {
      pinnedHeightRef.current = fit
      setPinnedHeight(fit)
    }
  }, [isCapabilities, items.length])

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
      // 同一个实例可能从 `/` 切成 `@`（触发字符换了但浮层位置没变），那时不能用上一种的钉高
      style={isCapabilities && pinnedHeight ? { height: pinnedHeight } : undefined}
    >
      <div ref={titleRef} className="chat-command-palette-title">
        <IconCommand size={12} /> {title}
        {items.length > 0 && <span className="chat-command-palette-count">{items.length} 项</span>}
        {onFilter && (
          <div className="chat-completion-filters" aria-label="补全类型筛选">
            {[
              ['skill', 'skill'],
              ['mcp', 'MCP'],
              ['uri-api', 'API 文档']
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
            <HighlightedLabel text={item.label} highlights={item.highlights} />
            <span className="chat-command-description">
              <HighlightedText
                text={item.description || ''}
                highlights={item.descriptionHighlights}
              />
            </span>
            <CompletionKindTag kind={item.kind} />
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 候选的类型标记。
 *
 * 只认 `/` 浮层里的四类：skill、MCP server、插件声明的条目（`prompt`）与按需文档
 * （`uri-api`）。`@` 文件补全的 `file` 不画标记——那里一整屏都是文件，标一排「file」只是噪声。
 */
// 标签只管「这一条是什么」：来源（`mica · plugin ·`）在悬停提示里说清归属，所以不另设一枚
// `plugin` 筛选——插件声明的提示词与按需文档本来就分属两个类型。
const COMPLETION_KIND_LABELS = { skill: 'skill', mcp: 'MCP', prompt: 'prompt', 'uri-api': 'API' }

function CompletionKindTag({ kind }) {
  const label = COMPLETION_KIND_LABELS[kind]
  if (!label) return null
  return <span className={`chat-command-kind is-${kind}`}>{label}</span>
}

/**
 * 悬停提示：说明全文 + 出处（插件 id / 配置文件）+「会插进去的东西」。
 *
 * 行上不再显示来源（`mica · plugin · computer-use` 太长，右侧只留一枚类型标签），出处整个
 * 挪到了这里。后两行与出处各自的 `detail` 相同，所以重复的那一段不再写第二遍。
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
