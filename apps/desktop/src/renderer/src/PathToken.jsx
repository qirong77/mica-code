import { createContext, useContext, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconFolder, IconFolderOpen, IconPhoto } from '@tabler/icons-react'
import { FloatingMenu, MenuItem, MenuSeparator } from './FloatingMenu'
import { isImagePath, splitTextByLinksAndPaths, splitTextByPaths } from './chat-paths'

/**
 * 聊天文本、回合日志里的路径动作。由 ChatView 在最外层提供（那里才知道会话 cwd 与
 * 打开面板/弹窗的方式），PathToken 只负责「怎么点」。
 *
 * 值：{ resolvePath(raw) -> 绝对路径, openFile(path, position), reveal(path), preview(path, text) }
 *
 * `openFile` 落到主区文件视图（文件开编辑器、目录把文件树切过去），`reveal` 交给
 * 系统文件管理器——两者就是点击菜单里的那两个选项。
 */
export const ChatPathContext = createContext(null)

/**
 * 文本里识别出的路径。
 *
 * 单击弹出打开方式（Finder / Mica），⌘ 点击直接走 Mica、中键同理；图片单击是预览，
 * 右键才出菜单——预览图片比在 Finder 里找到再双击更直接。
 *
 * 渲染成 inline 元素、样式只有下划线，所以不改变文本排版：同一段文字不管有没有被
 * 识别成路径，位置和换行都一样。
 */
export function PathToken({ path, text, line = null, column = null }) {
  const actions = useContext(ChatPathContext)
  const [menu, setMenu] = useState(null)
  const [pending, setPending] = useState(false)

  if (!actions) return text

  const image = isImagePath(path)
  const resolved = actions.resolvePath ? actions.resolvePath(path) : path
  const title = image
    ? `单击预览图片，右键选择打开方式：${resolved}\n⌘ / Ctrl 点击直接在 Mica 中打开`
    : `单击选择打开方式：${resolved}\n⌘ / Ctrl 点击直接在 Mica 中打开`

  // 打开目标可能跨进程（远程运行时），期间压暗自己，避免连点开出两个面板
  const run = (action) => {
    if (pending) return
    setMenu(null)
    setPending(true)
    const done = () => setPending(false)
    try {
      Promise.resolve(action()).finally(done)
    } catch {
      done()
    }
  }

  const openInFiles = () => run(() => actions.openFile(resolved, { line, column }))
  const revealInFinder = () => run(() => actions.reveal(resolved))
  const previewImage = () => run(() => actions.preview(resolved, text))

  // 键盘触发时没有鼠标坐标，落到元素自身的位置
  const menuPoint = (event) => {
    const rect = event.currentTarget?.getBoundingClientRect?.()
    return {
      x: event.clientX || (rect ? rect.left : 0),
      y: event.clientY || (rect ? rect.bottom + 2 : 0)
    }
  }

  const openMenu = (event) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu(menuPoint(event))
  }

  const activate = (event) => {
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()
      event.stopPropagation()
      openInFiles()
      return
    }
    if (image) {
      event.preventDefault()
      event.stopPropagation()
      previewImage()
      return
    }
    openMenu(event)
  }

  // 菜单挂到 body：它可能嵌在 markdown 的行内元素里，`div` 不能留在 `span` 内，
  // 也免得被对话区的滚动/裁剪容器切掉。
  const menuNode =
    menu && typeof document !== 'undefined'
      ? createPortal(
          <FloatingMenu x={menu.x} y={menu.y} minWidth={220} onClose={() => setMenu(null)}>
            <div className="truncate px-2 py-1 text-[11px] text-fg-muted" title={resolved}>
              {resolved}
            </div>
            <MenuSeparator />
            {image ? <MenuItem icon={IconPhoto} label="预览图片" onClick={previewImage} /> : null}
            <MenuItem icon={IconFolderOpen} label="在 Finder 中打开" onClick={revealInFinder} />
            <MenuItem icon={IconFolder} label="在 Mica 中打开" onClick={openInFiles} />
          </FloatingMenu>,
          document.body
        )
      : null

  return (
    <>
      <span
        className={`chat-path${image ? ' chat-path-image' : ''}${pending ? ' chat-path-pending' : ''}`}
        role="link"
        tabIndex={0}
        title={title}
        onClick={activate}
        onContextMenu={openMenu}
        onAuxClick={(event) => {
          // 中键 = 直接在 Mica 中打开，与浏览器里中键开标签页的手感一致
          if (event.button !== 1) return
          event.preventDefault()
          event.stopPropagation()
          openInFiles()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') activate(event)
        }}
      >
        {text}
      </span>
      {menuNode}
    </>
  )
}

/**
 * 纯文本里识别到的链接（`https://…` / `www.…`）。
 *
 * 用户消息、引用块、notice、思考都不走 markdown，链接得自己认出来。点击行为与
 * markdown 链接一致：交给运行时打开系统浏览器（`terminal.openExternal`）；没有
 * 运行时（比如静态渲染）时退回浏览器自己的跳转。
 */
function ChatLink({ url, text, children }) {
  const open = (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (typeof window === 'undefined') return
    const openExternal = window.mica?.terminal?.openExternal
    if (typeof openExternal === 'function') {
      Promise.resolve(openExternal(url)).catch(() => {})
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <a className="chat-link" href={url} rel="noreferrer" onClick={open} onAuxClick={open}>
      {children ?? text}
    </a>
  )
}

/**
 * 把一段纯文本里识别到的链接与路径渲染成可点元素，其余部分原样输出。
 * 两者都没有时直接返回字符串，不额外包一层节点（markdown 里的行内文本要靠这个
 * 保持原样）。
 */
export function PathText({ text, links = true }) {
  const segments = useMemo(
    () => (links ? splitTextByLinksAndPaths(text) : splitTextByPaths(text)),
    [text, links]
  )
  if (!segments.some((segment) => segment.type === 'path' || segment.type === 'link'))
    return text || null
  return segments.map((segment, index) =>
    segment.type === 'path' ? (
      <PathToken
        key={`path:${index}:${segment.start}`}
        path={segment.path}
        text={segment.text}
        line={segment.line}
        column={segment.column}
      />
    ) : segment.type === 'link' ? (
      <ChatLink key={`link:${index}:${segment.start}`} url={segment.url} text={segment.text} />
    ) : (
      <span key={`text:${index}`}>{segment.text}</span>
    )
  )
}
