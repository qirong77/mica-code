import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorWorkspace } from './EditorWorkspace'
import { TextPrompt } from './text-prompt'
import { BASE_PARAM, CWD_PARAM, HEAD_PARAM, readFilesUrl } from './app-url'

/**
 * 独立文件窗口（`/files`，dev 下 `files.html`）。
 *
 * 顶栏的编辑器按钮开的就是这一页：**只有文件树与编辑器**，没有左侧会话列表、没有「返回
 * 对话」、也没有别的视图入口——主窗口留在对话里，两者并排看。目录从地址的 `?cwd=` 来，
 * 所以刷新、换台机器打开都还停在同一处；没带目录时就是文件视图自己的空态。
 *
 * 窗口由外壳创建（`main/index.js` 的 `openAppPageWindow`），macOS 上隐藏了标题栏、交通灯
 * 浮在页面左上，所以顶上留一条可拖动的窄条（否则窗口无法移动）。
 *
 * 地址里还能带一对 `?base=&head=`：那是「打开某个对比」——插件的 Pull Request 菜单就点
 * 这个链接，编辑器一打开就停在 `head` 相对 `base` 的 Git 面板上（`<=` 形式的两边都是提交，
 * 不读工作区）。在页面里改基线也只改地址，刷新与复制链接都回到同一份对比。
 */
export function FilesWindow() {
  const [{ cwd: initialCwd, compare: initialCompare }] = useState(() =>
    readFilesUrl(window.location.search)
  )
  const [cwd, setCwd] = useState(initialCwd)
  const [compare, setCompare] = useState(initialCompare)
  const [prompt, setPrompt] = useState(null)
  const promptResolver = useRef(null)

  useEffect(() => {
    const title = cwd ? `${baseName(cwd)} — 编辑器` : '编辑器'
    // 标题只说人话：`origin/feature-x` 里的前缀只是 git 的写法，地址里仍然带着它。
    const headLabel = String(compare?.head || '').replace(/^origin\//, '')
    document.title = headLabel ? `${title} · ${headLabel}` : title
    const url = new URL(window.location.href)
    if (cwd) url.searchParams.set(CWD_PARAM, cwd)
    else url.searchParams.delete(CWD_PARAM)
    if (compare?.head) {
      url.searchParams.set(HEAD_PARAM, compare.head)
      if (compare.base) url.searchParams.set(BASE_PARAM, compare.base)
      else url.searchParams.delete(BASE_PARAM)
    } else {
      url.searchParams.delete(HEAD_PARAM)
      url.searchParams.delete(BASE_PARAM)
    }
    window.history.replaceState(null, '', url)
  }, [cwd, compare])

  // 页面上改基线：`GitComparePicker` 给的是一份 `{ kind, ref, name, direct }`，
  // 这里只取它解析出的 ref——地址里存 ref 而不是显示名。
  const changeCompareBase = useCallback((value) => {
    setCompare((current) => (current ? { ...current, base: value?.ref || null } : current))
  }, [])

  // 改目标分支同理；切回「工作区」等于这份对比结束了，窗口回落到普通编辑器。
  const changeCompareHead = useCallback((value) => {
    setCompare((current) => (value?.ref ? { ...(current || {}), head: value.ref } : null))
  }, [])

  const askText = useCallback(
    (title, initial = '', hint = '') =>
      new Promise((resolve) => {
        promptResolver.current = resolve
        setPrompt({ title, initial, hint })
      }),
    []
  )
  const closePrompt = (value) => {
    setPrompt(null)
    promptResolver.current?.(value)
    promptResolver.current = null
  }
  // Esc 取消：输入框自己会处理，焦点不在输入框上时也不能让整个窗口没反应
  useEffect(() => {
    if (!prompt) return
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closePrompt(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // closePrompt 每次渲染都是新引用，但这里只关心「有没有弹窗」
  }, [prompt])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas">
      <header className="safe-top drag-region flex h-8 shrink-0 items-center border-b border-line bg-panel pl-30 pr-3">
        <span className="min-w-0 truncate text-xs font-medium text-fg-soft" title={cwd || ''}>
          {cwd || '文件'}
        </span>
      </header>
      <EditorWorkspace
        root={initialCwd}
        visible
        askText={askText}
        compare={compare}
        onCompareBaseChange={changeCompareBase}
        onCompareHeadChange={changeCompareHead}
        onCwdChange={setCwd}
        onCornerResizeStart={null}
      />
      {prompt && <TextPrompt prompt={prompt} onClose={closePrompt} />}
    </div>
  )
}

/** 路径的基名（顶栏与窗口标题用）：不吃 `monaco` 那份大家一起用的工具，免得这一页为了一个字符串拉起编辑器依赖。 */
function baseName(path) {
  const parts = String(path || '')
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
  return parts[parts.length - 1] || String(path || '')
}
