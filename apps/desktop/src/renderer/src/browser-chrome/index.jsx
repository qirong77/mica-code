import { createRoot } from 'react-dom/client'
import { Bar, INITIAL } from './Bar'
import { Boundary } from './CrashNotice'
import { Recent } from './Recent'
import { installBridge } from './bridge'
import {
  THEME_CACHE_KEY,
  initThemeFromCache,
  subscribeTheme,
  syncThemeFromCache
} from '../theme'
import './chrome.css'

/**
 * 受控浏览器顶栏 / 最近访问浮层的入口。
 *
 * 同一个入口出两个界面，靠 `?view=`：
 * - 默认（`?view=bar`）是 38px 顶栏，加载进浏览器窗口自身的页面；
 * - `?view=recent` 是最近访问列表，加载进主进程另开的浮层窗口（跟着窗口走、不抢焦点）。
 *
 * 没有 preload、没有 IPC：状态与动作走 `bridge.js` 的日志桥。主题跟其它窗口一样读
 * `theme.js` 的缓存，改主题时由 storage 事件对齐。
 */

const view = new URLSearchParams(window.location.search).get('view') === 'recent' ? 'recent' : 'bar'

initThemeFromCache()
document.body.classList.add(view === 'recent' ? 'chrome-recent-root' : 'chrome-bar-root')
if (view === 'recent') {
  // 浮层要透出下面的网页：theme.js 会把根底色写成画布色，这里先清掉，之后每次换主题再清
  const clear = () => {
    document.documentElement.style.background = 'transparent'
  }
  clear()
  subscribeTheme(clear)
}
window.addEventListener('storage', (event) => {
  if (event.key === THEME_CACHE_KEY) syncThemeFromCache()
})

const store = installBridge(
  view === 'recent' ? '__micaRecent' : '__micaChrome',
  view === 'recent' ? { items: [], highlight: -1 } : { ...INITIAL }
)

createRoot(document.getElementById('root')).render(
  <Boundary>{view === 'recent' ? <Recent store={store} /> : <Bar store={store} />}</Boundary>
)
