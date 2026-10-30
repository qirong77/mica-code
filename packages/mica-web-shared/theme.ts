/**
 * 亮/暗色主题偏好的纯逻辑。
 *
 * 三处消费者必须对「这个值认不认」「auto 最终解析成什么」「ui-state 里用哪个键」
 * 给出同一个答案：桌面渲染层（启动、xterm/monaco 跟随）、设置页（Appearance 页签）、
 * 以及首帧启动脚本。判断只写在这一份里，别在各自入口里再抄一遍。
 */

/** 设置页可选的偏好。`auto` 跟随系统（`prefers-color-scheme`）。 */
export const THEME_PREFERENCES = ['auto', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** 真正作用到 DOM 的主题；`auto` 在这一层已经被解析掉。 */
export type ResolvedTheme = 'light' | 'dark';

/** 界面状态（运行时 ui-state）里保存主题偏好的键。 */
export const THEME_UI_STATE_KEY = 'theme';

/** 没有任何保存值时跟随系统。 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'auto';

/**
 * `<meta name="theme-color">` 的取值：系统状态栏/标题栏按最终主题着色。
 * 暗色沿用渲染层原来的 `#2b2b2b`；亮色取内容画布白。
 */
export const THEME_COLOR_META: Record<ResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#2b2b2b',
};

/** 只认三个合法偏好；其余（旧数据、手改文件、undefined）一律回落到默认值。 */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'auto' ? value : DEFAULT_THEME_PREFERENCE;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'auto';
}

/**
 * 偏好 → 实际主题。只有 `auto` 需要系统信号；显式的 light/dark 与系统无关，
 * 因此主题切换不会因为系统主题变化而跟着抖。
 */
export function resolveThemeName(preference: unknown, prefersLight: boolean): ResolvedTheme {
  const normalized = normalizeThemePreference(preference);
  if (normalized === 'light') return 'light';
  if (normalized === 'dark') return 'dark';
  return prefersLight ? 'light' : 'dark';
}
