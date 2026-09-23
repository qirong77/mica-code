import { createContext, useContext, useMemo, useState } from 'react'
import { isImagePath, splitTextByPaths } from './chat-paths'

/**
 * 聊天文本、回合日志里的路径动作。由 ChatView 在最外层提供（那里才知道会话 cwd 与
 * 打开面板/弹窗的方式），PathToken 只负责「怎么点」。
 *
 * 值：{ resolvePath(raw) -> 绝对路径, openFile(path, position), reveal(path), preview(path, text) }
 */
export const ChatPathContext = createContext(null)

function runAction(run, event) {
  event.preventDefault()
  event.stopPropagation()
  run()
}

/**
 * 文本里识别出的路径。
 *
 * 动作与终端链接保持同一套心智：单击是最轻的动作（Finder），带修饰键才开编辑器。
 * 唯一的例外是图片——单击直接弹窗预览，比在 Finder 里找到再双击更直接。
 *
 * 渲染成 inline 元素、只在 hover 时加样式，所以不改变文本排版：同一段文字不管
 * 有没有被识别成路径，位置和换行都一样。
 */
export function PathToken({ path, text, line = null, column = null }) {
  const actions = useContext(ChatPathContext)
  const [pending, setPending] = useState(false)

  if (!actions) return text

  const image = isImagePath(path)
  const resolved = actions.resolvePath ? actions.resolvePath(path) : path
  const hint = image ? '点击预览图片' : '点击在 Finder 中打开'
  const title = `${hint}：${resolved}\n⌘ / Ctrl 点击在编辑器中打开`

  const openInEditor = (event) =>
    runAction(() => actions.openFile(resolved, { line, column }), event)
  const previewImage = (event) => runAction(() => actions.preview(resolved, text), event)
  const revealInFinder = (event) =>
    runAction(() => {
      if (pending) return
      setPending(true)
      Promise.resolve(actions.reveal(resolved)).finally(() => setPending(false))
    }, event)

  const activate = (event) => {
    if (event.metaKey || event.ctrlKey) return openInEditor(event)
    if (image) return previewImage(event)
    return revealInFinder(event)
  }

  return (
    <span
      className={`chat-path${image ? ' chat-path-image' : ''}${pending ? ' chat-path-pending' : ''}`}
      role="link"
      tabIndex={0}
      title={title}
      onClick={activate}
      onAuxClick={(event) => {
        // 中键 = 编辑器，与浏览器里中键开标签页的手感一致
        if (event.button !== 1) return
        openInEditor(event)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') activate(event)
      }}
    >
      {text}
    </span>
  )
}

/**
 * 把一段纯文本里识别到的路径渲染成可点元素，其余部分原样输出。
 * 没有任何路径时直接返回字符串，不额外包一层节点（markdown 里的行内文本要靠这个
 * 保持原样）。
 */
export function PathText({ text }) {
  const segments = useMemo(() => splitTextByPaths(text), [text])
  if (!segments.some((segment) => segment.type === 'path')) return text || null
  return segments.map((segment, index) =>
    segment.type === 'path' ? (
      <PathToken
        key={`path:${index}:${segment.start}`}
        path={segment.path}
        text={segment.text}
        line={segment.line}
        column={segment.column}
      />
    ) : (
      <span key={`text:${index}`}>{segment.text}</span>
    )
  )
}
