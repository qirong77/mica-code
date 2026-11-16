import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorWorkspace } from './EditorWorkspace'
import { TextPrompt } from './text-prompt'

/** 路径的父目录：目录本身用它自己。`/a/b.md` → `/a`，`/a` → `/`。 */
function dirOf(path) {
  const trimmed = String(path || '').replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

function baseOf(path) {
  const trimmed = String(path || '').replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/**
 * 编辑器窗口（外壳 `?editor=<路径>`）。
 *
 * 整窗只有编辑器：一条可拖动的标题条 + 文件树/编辑区 + 底栏（左下 Git、右下当前文件路径）。
 * 没有会话、没有侧栏——它打开的是**一个文件**，不是「这台运行时上的界面」，所以刷新、
 * 换主题都还在这条路径上。
 *
 * 打开目标只做一次：文件直接开编辑器页签，目录把文件树切过去（文件/目录的判断在
 * FilesView 的 `openPath` 里，它要问运行时才知道）。
 */
export default function EditorWindow({ path }) {
  const filesRef = useRef(null)
  const [activePath, setActivePath] = useState(null)
  // 这里没有会话那套输入弹窗，但底栏的分支菜单要「创建新分支」时得问一句名字：
  // 用与对话区同一个 `TextPrompt`，别为了一扇窗口再写一个输入框。
  const [prompt, setPrompt] = useState(null)
  const promptResolver = useRef(null)
  const root = useMemo(() => dirOf(path), [path])
  const contextKey = useMemo(() => `editor:${root}`, [root])

  const askText = useCallback(
    (title, initial = '', hint = '') =>
      new Promise((resolve) => {
        promptResolver.current = resolve
        setPrompt({ title, initial, hint })
      }),
    []
  )
  const closePrompt = useCallback((value) => {
    setPrompt(null)
    promptResolver.current?.(value)
    promptResolver.current = null
  }, [])

  useEffect(() => {
    const name = baseOf(path)
    document.title = name ? `${name} — Mica` : 'Mica'
  }, [path])

  useEffect(() => {
    // 首次挂载时 FilesView 已经在同一批 commit 里 ref 就位；目录会在它内部切成新的根。
    void filesRef.current?.openPath?.(path)
  }, [path])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-canvas text-fg-strong">
      {/* 桌面端留一条拖动条：交通灯由系统画在页面之上，这条空档让下面不再被它们压住。 */}
      <div
        className="drag-region flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel pl-30 pr-3 text-xs text-fg-soft"
        aria-hidden="true"
      >
        <span className="min-w-0 truncate">{activePath || path}</span>
      </div>
      <EditorWorkspace
        ref={filesRef}
        root={root}
        contextKey={contextKey}
        visible
        askText={askText}
        showFilePath
        onActivePathChange={setActivePath}
      />
      {prompt && <TextPrompt prompt={prompt} onClose={closePrompt} />}
    </div>
  )
}
