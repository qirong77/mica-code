/**
 * 页面跑在哪种宿主里。
 *
 * 同一份 renderer 产物有两个宿主：Electron 外壳（窗口由主进程管）与浏览器（窗口就是
 * 标签页）。差异只影响「需要开新窗口时怎么办」，所以判断只写这一处。
 */

/** 页面是不是跑在 Electron 外壳里（外壳的 UA 带 Electron 标记，普通浏览器没有）。 */
export function isElectronShell(userAgent) {
  return /\bElectron\//i.test(String(userAgent || ''))
}
