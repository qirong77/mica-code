/**
 * 渲染层的主题运行时：偏好从运行时界面状态（ui-state 的 `theme` 键）来，落到
 * `<html data-theme>` 上，再把最终主题广播给 xterm / monaco 这类读不到 CSS 变量的消费者。
 *
 * 两层颜色的分工：
 * - 颜色本身在 CSS 里（`assets/app.css` 的 `@theme` 与 `[data-theme='light']` 覆盖），
 *   切换只是换一个属性，所有页面/窗口立刻跟着变，不重载、不重建组件；
 * - 这里只负责「现在是哪个主题」以及同步给读 options 的库。
 *
 * 首帧由 `public/theme-boot.js` 同步上色（读 localStorage 缓存，见 CACHE_KEY）；缓存只是
 * 为了避免亮色用户先看到一帧暗色，运行时的 ui-state 才是唯一事实来源——`syncFromUiState`
 * 在启动拉到界面状态后以它为准。
 */
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COLOR_META,
  THEME_UI_STATE_KEY,
  normalizeThemePreference,
  resolveThemeName
} from '@packages/mica-web-shared/index.js'

/** 启动脚本 `public/theme-boot.js` 也读这个键（那边是 classic script，只能各写一份常量）。 */
export const THEME_CACHE_KEY = 'mica.theme.preference'

const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)'

let preference = DEFAULT_THEME_PREFERENCE
let resolved = null
let mediaQuery = null
let mediaBound = false
const themeListeners = new Set()
const preferenceListeners = new Set()

function systemPrefersLight() {
  return mediaQuery ? mediaQuery.matches : false
}

function notifyTheme() {
  for (const listener of [...themeListeners]) {
    try {
      listener(resolveThemeName(preference, systemPrefersLight()))
    } catch (error) {
      console.error('[mica] 主题监听器执行失败', error)
    }
  }
}

function notifyPreference() {
  for (const listener of [...preferenceListeners]) {
    try {
      listener(preference)
    } catch (error) {
      console.error('[mica] 主题偏好监听器执行失败', error)
    }
  }
}

function readCachedPreference() {
  try {
    const cached = window.localStorage.getItem(THEME_CACHE_KEY)
    return cached === null ? DEFAULT_THEME_PREFERENCE : normalizeThemePreference(cached)
  } catch {
    // 隐私模式 / 存储被禁用：缓存读不到就回到默认值，ui-state 到达后仍然会修正。
    return DEFAULT_THEME_PREFERENCE
  }
}

function writeCachedPreference(next) {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, next)
  } catch {
    // 写不进去只影响下一次启动的首帧，不影响本次切换，不打断用户操作。
  }
}

/** 监听系统亮暗变化：只有 `auto` 跟着变，显式选定的主题不被系统带跑。 */
function bindSystemTheme() {
  if (mediaBound || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  mediaQuery = window.matchMedia(LIGHT_MEDIA_QUERY)
  mediaBound = true
  const onChange = () => {
    if (preference !== 'auto') return
    applyResolvedTheme(resolveThemeName(preference, systemPrefersLight()))
  }
  if (typeof mediaQuery.addEventListener === 'function')
    mediaQuery.addEventListener('change', onChange)
  else if (typeof mediaQuery.addListener === 'function') mediaQuery.addListener(onChange)
}

/** 把最终主题写到 DOM 上；返回实际生效的主题，方便调用方（启动日志/测试）读取。 */
export function applyResolvedTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark'
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', next)
    document.documentElement.style.colorScheme = next
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', THEME_COLOR_META[next])
    // 装到 iOS 主屏后，状态栏文字颜色由这条决定：亮色页面必须用 default（深色文字），
    // 否则 black-translucent 的白字在白底上看不见。
    const iosStatusBar = document.querySelector(
      'meta[name="apple-mobile-web-app-status-bar-style"]'
    )
    if (iosStatusBar)
      iosStatusBar.setAttribute('content', next === 'light' ? 'default' : 'black-translucent')
  }
  const changed = resolved !== next
  resolved = next
  if (changed) notifyTheme()
  return next
}

/** 应用一个偏好：归一化 → 写首帧缓存 → 解析并落地。 */
export function applyThemePreference(value, { cache = true } = {}) {
  bindSystemTheme()
  const next = normalizeThemePreference(value)
  const preferenceChanged = next !== preference
  preference = next
  if (cache) writeCachedPreference(next)
  const theme = applyResolvedTheme(resolveThemeName(preference, systemPrefersLight()))
  if (preferenceChanged) notifyPreference()
  return theme
}

/**
 * 页面脚本启动时先按缓存上色，避免「首帧暗、随后变亮」。
 * 缓存里没有值也仍然按 `auto` 把首帧定下来，与 boot 脚本的结果保持一致。
 */
export function initThemeFromCache() {
  return applyThemePreference(readCachedPreference(), { cache: false })
}

/** 缓存被本页其他窗口改写后重新对齐（终端窗口没有 ui-state 通道，只能读缓存）。 */
export function syncThemeFromCache() {
  return applyThemePreference(readCachedPreference(), { cache: false })
}

/**
 * 运行时界面状态到达后以它为准。缺失/非法值按 `auto` 处理；与当前偏好一致时
 * 不重复广播，避免每个无关的 ui-state 补丁都触发一轮监听。
 */
export function syncThemeFromUiState(value) {
  if (value !== undefined && normalizeThemePreference(value) === preference) {
    bindSystemTheme()
    return resolved
  }
  return applyThemePreference(value)
}

/** 设置页改主题：当前窗口立即生效，再写回运行时让其他窗口/设备跟进。 */
export function setThemePreference(value) {
  const theme = applyThemePreference(value)
  const uiState = typeof window === 'undefined' ? null : window.mica?.uiState
  if (uiState?.patch) {
    // 界面状态写失败不该回滚已经生效的主题：下次启动仍会按 ui-state 对齐，
    // 但那之前用户看到的是自己刚选的主题。
    Promise.resolve(uiState.patch({ [THEME_UI_STATE_KEY]: preference })).catch((error) => {
      console.error('[mica] 保存主题偏好失败', error)
    })
  }
  return theme
}

export function currentThemePreference() {
  return preference
}

export function currentThemeName() {
  return resolved ?? resolveThemeName(preference, systemPrefersLight())
}

/** 最终主题变化（含 auto 跟随系统变化）时回调。 */
export function subscribeTheme(listener) {
  if (typeof listener !== 'function') return () => {}
  themeListeners.add(listener)
  return () => themeListeners.delete(listener)
}

/** 偏好变化（设置页单选高亮）时回调；系统亮暗变化不触发。 */
export function subscribeThemePreference(listener) {
  if (typeof listener !== 'function') return () => {}
  preferenceListeners.add(listener)
  return () => preferenceListeners.delete(listener)
}

export { THEME_UI_STATE_KEY }
