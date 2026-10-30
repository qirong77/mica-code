import { useCallback, useEffect, useRef, useState } from 'react'
import { FilesView } from './FilesView'
import { TextPrompt } from './text-prompt'
import { readFilesUrl } from './app-url'
import { useGitWorkspace } from './useGitWorkspace'

/**
 * 独立文件窗口（`/files`，dev 下 `files.html`）。
 *
 * 顶栏的文件夹按钮开的就是这一页：**只有文件树与编辑器**，没有左侧会话列表、没有「返回
 * 对话」、也没有别的视图入口——主窗口留在对话里，两者并排看。目录从地址的 `?cwd=` 来，
 * 所以刷新、换台机器打开都还停在同一处；没带目录时就是文件视图自己的空态。
 *
 * 窗口由外壳创建（`main/index.js` 的 `openAppPageWindow`），macOS 上隐藏了标题栏、交通灯
 * 浮在页面左上，所以顶上留一条可拖动的窄条（否则窗口无法移动）。
 */
export function FilesWindow() {
  const [{ cwd }] = useState(() => readFilesUrl(window.location.search))
  const { git, compareBase, refresh, setCompareBase } = useGitWorkspace(cwd)
  const [prompt, setPrompt] = useState(null)
  const promptResolver = useRef(null)

  useEffect(() => {
    document.title = cwd ? `${baseName(cwd)} — 文件` : '文件'
  }, [cwd])

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
      <FilesView
        root={cwd}
        visible
        askText={askText}
        gitCwd={git.cwd || cwd}
        gitRepository={git.repository}
        gitBranchChanges={git.branch}
        gitLoading={git.loading}
        gitBranch={git.status?.branch || null}
        gitCompareBase={compareBase}
        gitCompareError={git.compareError}
        onGitCompareBaseChange={setCompareBase}
        onRefreshGit={() => refresh({ quiet: true })}
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
