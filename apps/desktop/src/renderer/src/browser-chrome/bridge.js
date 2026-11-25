import { encodeChromeMessage } from '@packages/mica-web-shared'

/**
 * 顶栏 / 最近访问面板与主进程之间的桥。
 *
 * 两个窗口都没有 preload（见 `packages/mica-web-shared/browser-chrome.ts` 的说明）：
 * - 页面 → 主进程：一行 console 日志，主进程在 `console-message` 里认前缀；
 * - 主进程 → 页面：`executeJavaScript('window.<name>.update(state)')`。
 */

/** 发一条动作给主进程。参数只放这一个动作需要的东西。 */
export function post(action, payload) {
  console.log(encodeChromeMessage({ action, ...(payload || {}) }))
}

/**
 * 装上 `window.__micaChrome` / `window.__micaRecent`，并把它包成 `useSyncExternalStore`
 * 能直接吃的 store：快照引用只在 update 时替换，页面不用自己比对。
 */
export function installBridge(name, initial, methods = {}) {
  let snapshot = initial
  const listeners = new Set()
  window[name] = {
    ...methods,
    update(next) {
      snapshot = next && typeof next === 'object' ? next : initial
      for (const listener of [...listeners]) listener()
    }
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      return snapshot
    }
  }
}
