import { IconCommand } from '@tabler/icons-react'

/**
 * 输入框上方的补全候选浮层（`@` 文件 / `/` skill）。
 *
 * 只负责展示与选中回调，选中后怎么改写输入框由 ChatView 决定——这里不执行任何动作。
 * 每行是「名称 | 说明」两列：名称按内容取宽且永不压缩（它是扫描目标），说明吃掉剩余
 * 宽度、放不下就省略号截断（浮层跟着输入框走，窄的时候只剩名称也是可用的）。
 * 名称里命中查询的字符会高亮，与 CLI 的文件补全一致（`labelHighlights` 是下标数组）。
 */
export default function ComposerCompletionPalette({
  title,
  options,
  activeIndex,
  onActiveIndex,
  onSelect,
  emptyText
}) {
  const items = options || []
  return (
    <div className="chat-command-palette chat-completion-palette" role="listbox" aria-label={title}>
      <div className="chat-command-palette-title">
        <IconCommand size={12} /> {title}
        <span>↑↓ 选择 · Enter/Tab 插入 · Esc 关闭</span>
      </div>
      {items.length === 0 && <div className="chat-select-empty">{emptyText}</div>}
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? 'chat-command-active' : ''}
          onMouseEnter={() => onActiveIndex(index)}
          // 按下就插入，避免 mousedown 先把焦点从 textarea 拿走
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(item)}
        >
          <HighlightedLabel text={item.label} highlights={item.highlights} />
          <span className="chat-command-description">{item.description || ''}</span>
        </button>
      ))}
    </div>
  )
}

/** 把 `labelHighlights` 标出的字符包成 `<mark>`，其余原样输出（下标是 label 的字符下标）。 */
function HighlightedLabel({ text, highlights }) {
  const label = String(text ?? '')
  const marked = new Set(
    (Array.isArray(highlights) ? highlights : []).filter(
      (index) => Number.isInteger(index) && index >= 0 && index < label.length
    )
  )
  if (marked.size === 0) return <code>{label}</code>

  const parts = []
  let buffer = ''
  let bufferMarked = false
  const flush = () => {
    if (!buffer) return
    parts.push(bufferMarked ? <mark key={parts.length}>{buffer}</mark> : buffer)
    buffer = ''
  }
  for (let index = 0; index < label.length; index += 1) {
    const isMarked = marked.has(index)
    if (isMarked !== bufferMarked) {
      flush()
      bufferMarked = isMarked
    }
    buffer += label[index]
  }
  flush()
  return <code>{parts}</code>
}
