import { IconCommand } from '@tabler/icons-react'

/**
 * 输入框上方的补全候选浮层（`@` 文件 / `/` skill）。
 *
 * 只负责展示与选中回调，选中后怎么改写输入框由 ChatView 决定——这里不执行任何动作。
 * 每行是「名称 | 说明」两列：名称按内容取宽且永不压缩（它是扫描目标），说明吃掉剩余
 * 宽度、放不下就省略号截断（浮层跟着输入框走，窄的时候只剩名称也是可用的）。
 */
export default function ComposerCompletionPalette({
  title,
  options,
  activeIndex,
  onActiveIndex,
  onSelect,
  loading,
  hint
}) {
  const items = options || []
  return (
    <div className="chat-command-palette chat-completion-palette" role="listbox" aria-label={title}>
      <div className="chat-command-palette-title">
        <IconCommand size={12} /> {title}
        <span>↑↓ 选择 · Enter 插入 · Esc 关闭</span>
      </div>
      {items.length === 0 && (
        <div className="chat-select-empty">{loading ? '正在加载…' : hint}</div>
      )}
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
          <code>{item.label}</code>
          <span className="chat-command-description">{item.description || ''}</span>
        </button>
      ))}
    </div>
  )
}
