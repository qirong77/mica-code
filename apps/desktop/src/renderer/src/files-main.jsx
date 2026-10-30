import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './ErrorBoundary'
import { FilesWindow } from './files-window'
import '../assets/app.css'
import { THEME_UI_STATE_KEY } from '@packages/mica-web-shared/index.js'
import { ensureMicaApi } from './transport'
import { ensureUiState, subscribeUiState, uiStateKeys } from './ui-state'
import { initThemeFromCache, syncThemeFromUiState } from './theme'

/**
 * 独立文件窗口的入口（`files.html`）。
 *
 * 和主应用同一套启动前提：`window.mica` 由 transport 经 HTTP + SSE 建立，界面状态（Git 比较
 * 基线、已审阅标记）从运行时取回；但没有工作区、没有对话，所以不读工作区也不开会话。
 * 主题和主窗口共用同一份界面状态：独立窗口的颜色不能和主窗口各走一套。
 */
initThemeFromCache()
ensureMicaApi()
  .then((api) => {
    if (!api) return null
    // 界面状态取不到不阻断启动：只影响 Git 比较基线这类共享偏好的初值。
    return ensureUiState().catch((error) => console.error('初始化界面状态失败', error))
  })
  .then((ready) => {
    if (ready === null) return
    syncThemeFromUiState(uiStateKeys()[THEME_UI_STATE_KEY])
    subscribeUiState(() => syncThemeFromUiState(uiStateKeys()[THEME_UI_STATE_KEY]))
    createRoot(document.getElementById('root')).render(
      <ErrorBoundary>
        <FilesWindow />
      </ErrorBoundary>
    )
  })
  .catch((error) => {
    console.error('初始化 mica 接口失败', error)
    const root = document.getElementById('root')
    if (!root) return
    const box = document.createElement('div')
    box.className = 'flex h-full flex-col items-center justify-center gap-2 p-8 text-center'
    const title = document.createElement('p')
    title.className = 'text-sm text-[var(--chat-text)]'
    title.textContent = '无法连接 Mica Code 运行时'
    const hint = document.createElement('p')
    hint.className = 'text-xs text-[var(--chat-text-dim)]'
    hint.textContent = String(error?.message || error)
    box.append(title, hint)
    root.replaceChildren(box)
  })
