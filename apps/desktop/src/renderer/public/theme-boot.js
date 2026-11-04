/**
 * 首帧主题：必须在样式落地之前同步执行，否则浅色用户会先看到一帧深色。
 *
 * 这是一份 **classic script**（不能 import、不能用 window.mica）：只读 `theme.js` 写入的
 * localStorage 缓存，按 `prefers-color-scheme` 解析 auto，然后把 `data-theme`、
 * `data-appearance`、`color-scheme`、根底色与 `<meta name="theme-color">` 定下来。
 * 运行时 ui-state 里的真实偏好在页面脚本启动后由 `syncFromUiState` 覆盖（缓存可能落后
 * 一次切换）。
 *
 * 下面这张表是 `packages/mica-web-shared/theme.ts` 的 THEMES 的副本——classic script 引不进
 * 模块，只能重复一遍。加主题时三处一起改：`theme.ts`、这里、以及 `assets/app.css` 的
 * `html[data-theme='<id>']` 块（`theme-tokens.test.js` 会拦住漏掉的那处）。
 */
;(function bootTheme() {
  var CACHE_KEY = 'mica.theme.preference'
  var LIGHT_MEDIA = '(prefers-color-scheme: light)'
  var THEMES = {
    dark: { appearance: 'dark', canvas: '#2b2b2b' },
    light: { appearance: 'light', canvas: '#ffffff' },
    mocha: { appearance: 'dark', canvas: '#1e1e2e' },
    latte: { appearance: 'light', canvas: '#eff1f5' },
    'tokyo-night': { appearance: 'dark', canvas: '#1a1b26' },
    'tokyo-night-light': { appearance: 'light', canvas: '#e6e7ed' }
  }
  var preference = 'auto'
  try {
    var cached = window.localStorage.getItem(CACHE_KEY)
    if (cached === 'auto' || Object.prototype.hasOwnProperty.call(THEMES, cached)) {
      preference = cached
    }
  } catch {
    // 存储在隐私模式下不可用：退化为跟随系统。
    preference = 'auto'
  }
  var prefersLight =
    typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_MEDIA).matches
  var theme =
    preference === 'auto' ? (prefersLight ? 'light' : 'dark') : preference
  var definition = THEMES[theme] || THEMES.dark
  var root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-appearance', definition.appearance)
  root.style.colorScheme = definition.appearance
  // 样式表还没到时整页只有这一层底色：用主题自己的画布色，避免深色主题闪白。
  root.style.background = definition.canvas
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', definition.canvas)
  var iosStatusBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
  if (iosStatusBar)
    iosStatusBar.setAttribute(
      'content',
      definition.appearance === 'light' ? 'default' : 'black-translucent'
    )
})()
