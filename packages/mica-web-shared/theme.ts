/**
 * 主题偏好的纯逻辑：有哪些主题、`auto` 解析成谁、`<html>` 上挂哪些属性、UI 状态里用什么键。
 *
 * 三处消费者必须给出同一个答案：桌面渲染层（启动、xterm/monaco 跟随）、设置页
 * （Appearance 页签）、以及首帧启动脚本。判断只写在这一份里，别在各自入口里再抄一遍
 * （`public/theme-boot.js` 与 `apps/config-web/web/index.html` 是 classic script，只能
 * 重复常量，不重复逻辑）。
 *
 * 颜色本身不在这里：每个主题的取值写在宿主自己的样式里——桌面端
 * `apps/desktop/src/renderer/assets/app.css` 的 `html[data-theme='<id>']` 块，设置页
 * `packages/mica-config-ui/web/styles.css` 的同一选择器。这里只登记 id / 明暗 / 标签，
 * 以及首帧要用的画布色。
 */

/** 真正作用到 DOM 的主题。id 同时是 `<html data-theme>` 的取值与 ui-state 里存的值。 */
export type ThemeId = 'dark' | 'light' | 'mocha' | 'latte' | 'tokyo-night' | 'tokyo-night-light'

/** 明暗档：决定 `data-appearance`、`color-scheme` 与那些「亮底要单独处理」的规则。 */
export type ThemeAppearance = 'light' | 'dark'

/** 真正作用到 DOM 的主题（`auto` 在这一层已经被解析掉）。 */
export type ResolvedTheme = ThemeId

/** `auto` 在系统为深色 / 浅色时分别落到哪个主题。 */
export const DEFAULT_DARK_THEME: ThemeId = 'dark'
export const DEFAULT_LIGHT_THEME: ThemeId = 'light'

export type ThemeDefinition = {
  id: ThemeId
  /** 设置页主题卡上的名字。主题名是专有名词，不翻译。 */
  label: string
  /** 一句话说明这个主题长什么样（设置页副标题）。 */
  description: string
  appearance: ThemeAppearance
  /** 同源的另一档明暗，设置页不展示，只用于「这个主题有没有亮/暗兄弟」的判断。 */
  pair: ThemeId
  /** 内容画布色：首帧底色与 `<meta name="theme-color">`，必须等于该主题的 `--color-canvas`。 */
  canvas: string
}

/**
 * 全部主题。前两个是原来的 Darcula / DeepSeek 亮色（id 保持 `dark` / `light`，旧数据继续有效），
 * 后面是两对 VS Code 主题的移植：取值分别来自 Catppuccin 官方调色板与 Tokyo Night 的
 * theme JSON（见 app.css 对应块的注释）。
 */
export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'dark',
    label: 'Darcula',
    description: 'JetBrains 的暖橙深色，VS Code 同款',
    appearance: 'dark',
    pair: 'light',
    canvas: '#2b2b2b'
  },
  {
    id: 'light',
    label: '浅色',
    description: '白底近黑正文，DeepSeek harness 配色',
    appearance: 'light',
    pair: 'dark',
    canvas: '#ffffff'
  },
  {
    id: 'mocha',
    label: 'Catppuccin Mocha',
    description: '柔和低对比的深色，粉紫强调色',
    appearance: 'dark',
    pair: 'latte',
    canvas: '#1e1e2e'
  },
  {
    id: 'latte',
    label: 'Catppuccin Latte',
    description: '柔和低对比的浅色，与 Mocha 同源',
    appearance: 'light',
    pair: 'mocha',
    canvas: '#eff1f5'
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    description: '夜色蓝调的深色，蓝青强调色',
    appearance: 'dark',
    pair: 'tokyo-night-light',
    canvas: '#1a1b26'
  },
  {
    id: 'tokyo-night-light',
    label: 'Tokyo Night Light',
    description: '灰蓝底的浅色，与 Tokyo Night 同源',
    appearance: 'light',
    pair: 'tokyo-night',
    canvas: '#e6e7ed'
  }
]

/** 设置页可选的偏好：`auto` 跟随系统，其余是具体主题。 */
export const THEME_PREFERENCES = ['auto', ...THEMES.map((theme) => theme.id)] as const

export type ThemePreference = 'auto' | ThemeId

/** 界面状态（运行时 ui-state）里保存主题偏好的键。 */
export const THEME_UI_STATE_KEY = 'theme'

/** 没有任何保存值时跟随系统。 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'auto'

const THEME_BY_ID = new Map<string, ThemeDefinition>(THEMES.map((theme) => [theme.id, theme]))

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_BY_ID.has(value)
}

/** 只认 `auto` 与登记过的 id；其余（旧数据、手改文件、undefined）一律回落到默认值。 */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'auto' || isThemeId(value) ? value : DEFAULT_THEME_PREFERENCE
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'auto' || isThemeId(value)
}

/**
 * 偏好 → 实际主题。只有 `auto` 需要系统信号；显式选定的主题与系统无关，
 * 因此主题切换不会因为系统亮暗变化而跟着抖。
 */
export function resolveThemeName(preference: unknown, prefersLight: boolean): ThemeId {
  const normalized = normalizeThemePreference(preference)
  if (normalized === 'auto') return prefersLight ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME
  return normalized
}

/** 主题的明暗档。未知 id 按深色处理（与 `:root` 的默认取值一致）。 */
export function themeAppearance(theme: unknown): ThemeAppearance {
  return isThemeId(theme) ? THEME_BY_ID.get(theme)!.appearance : 'dark'
}

/** 主题的内容画布色：首帧底色与 `<meta name="theme-color">`。 */
export function themeCanvasColor(theme: unknown): string {
  return isThemeId(theme) ? THEME_BY_ID.get(theme)!.canvas : THEMES[0]!.canvas
}

/** 主题的显示名（设置页卡片、启动日志）。 */
export function themeLabel(theme: unknown): string {
  return isThemeId(theme) ? THEME_BY_ID.get(theme)!.label : THEMES[0]!.label
}
