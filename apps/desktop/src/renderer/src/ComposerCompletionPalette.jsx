import { useEffect, useRef } from 'react'
import { IconCommand } from '@tabler/icons-react'

/**
 * 输入框上方的补全候选浮层（`@` 文件 / `/` skill）。
 *
 * 只负责展示与选中回调，选中后怎么改写输入框由 ChatView 决定——这里不执行任何动作。
 * 每行是「名称 | 说明」两列：名称按内容取宽且永不压缩（它是扫描目标），说明吃掉剩余
 * 宽度、放不下就省略号截断（浮层跟着输入框走，窄的时候只剩名称也是可用的）。
 * 名称与说明里命中查询的字符都会高亮（`highlights` / `descriptionHighlights` 是下标数组）。
 *
 * 滚动只发生在候选列表（`.chat-command-palette-body`）上：标题行与键位提示固定在顶部，
 * 键盘上下移动时由这里把当前行滚进视野，鼠标滚轮照常可用。
 */
export default function ComposerCompletionPalette({
  title,
  options,
  activeIndex,
  onActiveIndex,
  onSelect,
  emptyText
}) {
  const bodyRef = useRef(null)
  const items = options || []

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
    <div className="chat-command-palette chat-completion-palette">
      <div className="chat-command-palette-title">
        <IconCommand size={12} /> {title}
        {items.length > 0 && <span className="chat-command-palette-count">{items.length} 项</span>}
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
            // skill 插入的是路径而不是 `/name`，悬停时先让人看清会插进去什么
            title={item.kind === 'skill' ? item.path || undefined : undefined}
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
          </button>
        ))}
      </div>
    </div>
  )
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
