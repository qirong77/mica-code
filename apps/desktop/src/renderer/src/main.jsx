import { createRoot } from 'react-dom/client'
import { setConfigWebClient, setConfigWebThemeHost } from '@mica-config-ui/web'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import ShareIndex from './ShareIndex'
import '../assets/app.css'
import { ensureMicaApi } from './transport'
import { ensureUiState, subscribeUiState, uiStateKeys } from './ui-state'
import {
  THEME_UI_STATE_KEY,
  DEFAULT_RUNTIME_URL,
  isLoopbackRuntime
} from '@packages/mica-web-shared/index.js'
import { readAppUrl } from './app-url'
import { createDesktopConfigWebClient } from './config-web'
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
ensureMicaApi()
  .catch((error) => {
    console.error('初始化 mica 接口失败', error)
    renderBootError(error)
    return null
  })
  .then((api) => {
    if (!api) return
    // 界面状态（草稿/工作区/面板布局/主题偏好）来自运行时：先取回来再渲染，第一帧就是
    // 上一次留下的样子，不用先画一个空界面再对齐。取不到不阻断启动——只是回到默认界面，
    // 比整页停在一个错误提示上可用。
    return ensureUiState()
      .catch((error) => console.error('初始化界面状态失败', error))
      .then(() => {
        // 运行时保存的偏好比首帧缓存权威：以它为准重新上色，并让其他窗口的修改
        // （ui-state 广播）继续跟随。分享页也走这条路径，看到的是同一套配色。
        syncThemeFromUiState(uiStateKeys()[THEME_UI_STATE_KEY])
        subscribeUiState(() => syncThemeFromUiState(uiStateKeys()[THEME_UI_STATE_KEY]))

        // `/share` 本身是「分享链接列表」：这一页不需要工作区/草稿那些界面状态，也不该按
        // 「没有打开的会话」去开一条新会话，所以在渲染 App 之前就分出去。带 `?session=<id>`
        // 时仍旧渲染 App（只是不画左侧会话列表，见 App.jsx 的 shareView）。
        if (api.shareView && !readAppUrl(window.location.search).sessionId) {
          createRoot(document.getElementById('root')).render(
            <ErrorBoundary>
              <ShareIndex />
            </ErrorBoundary>
          )
          return
        }
        createRoot(document.getElementById('root')).render(
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        )
      })
  })

function renderBootError(error) {
  const root = document.getElementById('root')
  if (!root) return
  const box = document.createElement('div')
  box.className = 'flex h-full flex-col items-center justify-center gap-2 p-8 text-center'
  const title = document.createElement('p')
  title.className = 'text-sm text-[var(--chat-text)]'
  title.textContent = '无法连接 Mica Code 运行时'
  const hint = document.createElement('p')
  hint.className = 'text-xs text-[var(--chat-text-dim)]'
  hint.textContent = '请确认运行时进程仍在运行（npm run start:web 或重新启动应用）。'
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
}
