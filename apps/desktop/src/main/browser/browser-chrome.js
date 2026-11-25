/**
 * 受控浏览器顶栏的地址约定。
 *
 * 顶栏与它的「最近访问」浮层是一个**真正的渲染入口**（`src/renderer/browser-chrome.html`，
 * React + `@mica-config-ui/web`），由运行时托管在 `/browser-chrome`；dev 下由 Vite 直接
 * 提供 `/browser-chrome.html`（改样式即时生效）。主进程只负责把它加载进窗口、把窗口底色
 * 对齐当前主题，以及把状态推进页面（桥见 `packages/mica-web-shared/browser-chrome.ts`）。
 *
 * 它曾经是一条 data: URL 页面：那样引不进组件库，只能照着 Arco small 的尺寸手写一遍
 * Input / 按钮，还跟真实的 `Input`、`ArcoAction` 各走各的。改成独立入口之后，页面里
 * 用的就是同一个组件，配色也直接吃 app.css 的 token（`browser-chrome.css` 里有一份
 * 拷贝，`browser-chrome-tokens.test.js` 逐主题比对）。
 */

import { BROWSER_CHROME_PAGE_PATH } from '@packages/mica-web-shared'

/**
 * 页面地址。`base` 是运行时地址（dev 下是 Vite）；还没起来时返回空串，调用方负责重试。
 * `view=recent` 是同一个入口的另一个根：只画最近访问列表。
 */
export function chromePageUrl(base, { view = 'bar', dev = false } = {}) {
  const root = String(base || '')
    .trim()
    .replace(/\/+$/, '')
  if (!root) return ''
  const page = dev ? '/browser-chrome.html' : BROWSER_CHROME_PAGE_PATH
  const query = view === 'recent' ? '?view=recent' : ''
  return `${root}${page}${query}`
}

/** 最近访问浮层的页面：与顶栏同一个入口，只是换一个挂载点。 */
export function recentPageUrl(base, { dev = false } = {}) {
  return chromePageUrl(base, { view: 'recent', dev })
}
