/**
 * 首帧主题：必须在样式落地之前同步执行，否则亮色用户会先看到一帧暗色。
 *
 * 这是一份 **classic script**（不能 import、不能用 window.mica）：只读 `theme.js` 写入的
 * localStorage 缓存，按 `prefers-color-scheme` 解析 auto，然后把 `data-theme`、
 * `color-scheme` 与 `<meta name="theme-color">` 定下来。运行时 ui-state 里的真实偏好在
 * 页面脚本启动后由 `syncFromUiState` 覆盖（缓存可能落后一次切换）。
 *
 * 常量与解析规则要和 `src/theme.js`、`packages/mica-web-shared/theme.ts` 保持一致：
 * 这里只能用字符串重复一遍，改动时三处一起改。
 */
;(function bootTheme() {
  var CACHE_KEY = 'mica.theme.preference'
  var LIGHT_MEDIA = '(prefers-color-scheme: light)'
  var preference = 'auto'
  try {
    var cached = window.localStorage.getItem(CACHE_KEY)
    if (cached === 'light' || cached === 'dark' || cached === 'auto') preference = cached
  } catch {
    // 存储在隐私模式下不可用：退化为跟随系统。
    preference = 'auto'
  }
  var prefersLight =
    typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_MEDIA).matches
  var theme =
    preference === 'light'
      ? 'light'
      : preference === 'dark'
        ? 'dark'
        : prefersLight
          ? 'light'
          : 'dark'
  var root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#2b2b2b')
  var iosStatusBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
  if (iosStatusBar)
    iosStatusBar.setAttribute('content', theme === 'light' ? 'default' : 'black-translucent')
})()
