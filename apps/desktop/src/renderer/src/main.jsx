import { createRoot } from 'react-dom/client'
import {
  ArcoProvider,
  setConfigWebClient,
  setConfigWebEditor,
  setConfigWebThemeHost
} from '@mica-config-ui/web'
import { DesktopDialogHost } from './desktop-dialog'
import { NotificationHost } from './NotificationHost'
import { ErrorBoundary } from './ErrorBoundary'
import '../assets/app.css'
import { LocalJsonEditor } from './config-web-editor'
import { ensureMicaApi } from './transport'
import { ensureUiState, subscribeUiState, uiStateKeys } from './ui-state'
import {
  THEME_UI_STATE_KEY,
  DEFAULT_RUNTIME_URL,
  isLoopbackRuntime,
  isSharePath
} from '@packages/mica-web-shared/index.js'
import { readAppUrl } from './app-url'
import { createDesktopConfigWebClient } from './config-web'
import { createStartupTiming } from './startup-timing'

const startup = createStartupTiming(window)
startup.mark('main')

document.body.classList.add('mica-arco-theme')

// 编辑器在这里注册一次：设置页、会话详情和插件卡片（笔记）都读这一份。跟着设置页懒加载
// 会让「还没打开过设置就点开笔记」拿到朴素文本域，再也不会切回 monaco。
setConfigWebEditor(LocalJsonEditor)
import {
  currentThemePreference,
  initThemeFromCache,
  setThemePreference,
  subscribeThemePreference,
  syncThemeFromUiState
} from './theme'

// 配置页的数据源在这里接一次：会话详情（对话记录 / Context 分析 / 原始文件）也会在
// 对话区与统计页里打开，那些入口不经过设置页，不能等到 SettingsView 被懒加载才注册。
setConfigWebClient(createDesktopConfigWebClient())

// 主题：首帧已经在 theme-boot.js 里按缓存上过色，这里把运行时的偏好接进来。
// 设置页（Appearance）通过这个宿主读写主题——桌面端的唯一事实来源是运行时界面状态，
// 所以两个窗口同时开着设置页也会同步，关掉重开、换设备都还是同一个选择。
initThemeFromCache()
setConfigWebThemeHost({
  get: currentThemePreference,
  set: setThemePreference,
  subscribe: subscribeThemePreference
})

if (new URLSearchParams(window.location.search).get('viewport-debug') === '1') {
  void import('./viewport-diagnostics')
    .then(({ startViewportDiagnostics }) => startViewportDiagnostics(window, document))
    .catch((error) => console.warn('无法启动视口诊断', error))
}

// 性能埋点默认开启：每秒采样、每 15 秒整批落到日志目录（保留 7 天，重启不丢）。
// `?perf=0` 只在需要排除探针干扰时关闭。
const perfParam = new URLSearchParams(window.location.search).get('perf')
if (perfParam !== '0') {
  void import('./perf-probe')
    .then(({ startPerfProbe }) => startPerfProbe(window, document))
    .catch((error) => console.warn('无法启动性能探针', error))
}

// 渲染层错误采集：console.error/warn 与未捕获异常进同一套日志（scope=renderer）。
// 白屏和渲染抛错往往没有别的痕迹，这一条是唯一的现场。
void import('./log-probe')
  .then(({ startLogProbe }) => startLogProbe(window))
  .catch((error) => console.warn('无法启动日志采集', error))

// 页面在任何容器里都是同一份代码：window.mica 由 transport 适配层通过 HTTP + SSE
// 建立（Electron 外壳只是装载同一个地址）。连不上运行时时给出可读提示，不要白屏。
const quickButtonsDemo =
  new URLSearchParams(window.location.search).get('quick-buttons-demo') === '1'

// 外观验收页（`?quick-buttons-demo=1`）是纯静态的：只画按钮与预览卡片，不读会话、不发请求。
// 它在 `ensureMicaApi()` 之前渲染，才能在静态服务下打开，也不会先闪一屏连不上运行时的提示。
if (quickButtonsDemo) {
  startup.setView('demo')
  void import('./QuickButtonsPreviewDemo')
    .then(({ default: Demo }) => {
      createRoot(document.getElementById('root')).render(
        <ErrorBoundary>
          <Demo />
        </ErrorBoundary>
      )
      dismissBootPlaceholder()
    })
    .catch((error) => renderBootError(error, true))
}

if (!quickButtonsDemo) {
  // 在等待运行时环境与共享状态的同时加载对应页面；首次渲染仍必须等状态快照。
  const params = new URLSearchParams(window.location.search)
  const expectedView =
    params.get('pluginLauncher') && !isSharePath(window.location.pathname)
      ? 'launcher'
      : isSharePath(window.location.pathname) && !readAppUrl(window.location.search).sessionId
        ? 'share'
        : 'app'
  const modules = new Map()
  const loadView = (view) => {
    if (!modules.has(view)) {
      const promise = (
        view === 'launcher'
          ? import('./PluginLauncher')
          : view === 'share'
            ? import('./ShareIndex')
            : import('./App')
      ).then(
        (module) => ({ module, loadedAt: window.performance.now() }),
        (error) => ({ error })
      )
      modules.set(view, promise)
    }
    return modules.get(view)
  }
  void loadView(expectedView)

  void (async () => {
    const api = await ensureMicaApi()
    startup.mark('api')
    try {
      await ensureUiState()
    } catch (error) {
      console.error('初始化界面状态失败', error)
    }
    startup.mark('uiState')
    syncThemeFromUiState(uiStateKeys()[THEME_UI_STATE_KEY])
    subscribeUiState(() => syncThemeFromUiState(uiStateKeys()[THEME_UI_STATE_KEY]))

    const launcherId = params.get('pluginLauncher')
    const view =
      launcherId && !api.shareView
        ? 'launcher'
        : api.shareView && !readAppUrl(window.location.search).sessionId
          ? 'share'
          : 'app'
    const { module, error, loadedAt } = await loadView(view)
    if (error) {
      console.error('加载页面资源失败', error)
      startup.setView('error')
      renderBootError(error, true)
      return
    }
    startup.mark('viewReady')
    startup.setTime('viewLoaded', loadedAt)
    startup.setView(view)
    const content =
      view === 'launcher' ? (
        <module.PluginLauncher pluginId={launcherId} />
      ) : view === 'share' ? (
        <>
          <module.default />
          <DesktopDialogHost />
        </>
      ) : (
        <>
          <NotificationHost />
          <module.default />
          <DesktopDialogHost />
        </>
      )
    createRoot(document.getElementById('root')).render(
      <ErrorBoundary>
        <ArcoProvider>{content}</ArcoProvider>
      </ErrorBoundary>
    )
    dismissBootPlaceholder()
  })().catch((error) => {
    console.error('启动 Mica 失败', error)
    startup.setView('error')
    renderBootError(error)
  })
}

/**
 * 摘掉 index.html 里的启动占位（首帧底色 + 「正在载入…」）。React 18 的首次提交是
 * 异步的，render() 返回时 DOM 还可能是空的，所以按 #root 的子节点变化来摘。
 */
function dismissBootPlaceholder() {
  const boot = document.getElementById('boot')
  if (!boot) {
    startup.finish()
    return
  }
  const root = document.getElementById('root')
  if (!root || root.childElementCount > 0) {
    boot.remove()
    startup.finish()
    return
  }
  const observer = new MutationObserver(() => {
    if (root.childElementCount === 0) return
    observer.disconnect()
    boot.remove()
    startup.finish()
  })
  observer.observe(root, { childList: true })
}

function renderBootError(error, resourceFailure = false) {
  const root = document.getElementById('root')
  if (!root) return
  const box = document.createElement('div')
  box.className = 'flex h-full flex-col items-center justify-center gap-2 p-8 text-center'
  const title = document.createElement('p')
  title.className = 'text-sm text-[var(--chat-text)]'
  title.textContent = resourceFailure ? '无法加载页面资源' : '无法连接 Mica Code 运行时'
  const hint = document.createElement('p')
  hint.className = 'text-xs text-[var(--chat-text-dim)]'
  hint.textContent = resourceFailure
    ? '请检查网络连接，然后刷新页面重试。'
    : '请确认运行时进程仍在运行（npm run start:web 或重新启动应用）。'
  const detail = document.createElement('p')
  detail.className = 'max-w-md text-[11px] text-[var(--chat-text-dim)]'
  detail.textContent = String(error?.message || error)
  box.append(title, hint, detail)

  // 地址是切过去的另一台 mica 时（那台关机/重启了）给一条回本机的退路，
  // 否则整页停在错误页、连切换入口都点不到。
  if (!isLoopbackRuntime(window.location.origin)) {
    const home = document.createElement('button')
    home.type = 'button'
    home.className =
      'mt-2 rounded-sm border border-line bg-panel-hi px-3 py-1 text-xs text-fg hover:bg-active'
    home.textContent = '返回本机'
    home.addEventListener('click', () => window.location.assign(DEFAULT_RUNTIME_URL))
    box.append(home)
  }
  root.replaceChildren(box)
  dismissBootPlaceholder()
}
