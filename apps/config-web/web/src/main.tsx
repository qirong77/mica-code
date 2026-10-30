import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COLOR_META,
  normalizeThemePreference,
  resolveThemeName,
  type ResolvedTheme,
  type ThemePreference,
} from '@packages/mica-web-shared/index.js';
import './host.css';
import {
  ConfigWebApp,
  setConfigWebClient,
  setConfigWebEditor,
  setConfigWebThemeHost,
} from '@packages/mica-config-ui/web/index.js';
import { createHttpConfigWebClient } from './http-client.js';
import { MonacoJsonEditor } from './monaco-editor.js';

/**
 * 浏览器宿主的主题能力。
 *
 * 浏览器宿主没有运行时界面状态（桌面宿主把主题存 ui-state），偏好就存在这个浏览器
 * 自己的 localStorage 里。首帧由 `web/index.html` 的内联脚本按同一个键上色——那边是
 * classic script，只能把常量重复一遍，改键时两处一起改；这里负责切换、跟随系统与
 * 多标签同步。
 */
const THEME_CACHE_KEY = 'mica.theme.preference';
const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)';

const lightMedia = window.matchMedia(LIGHT_MEDIA_QUERY);
const preferenceListeners = new Set<(next: ThemePreference) => void>();
let preference: ThemePreference = readCachedPreference();

function readCachedPreference(): ThemePreference {
  try {
    return normalizeThemePreference(window.localStorage.getItem(THEME_CACHE_KEY));
  } catch {
    // 隐私模式 / 存储被禁用：读不到就回到默认值（跟随系统）。
    return DEFAULT_THEME_PREFERENCE;
  }
}

function resolvedTheme(): ResolvedTheme {
  return resolveThemeName(preference, lightMedia.matches);
}

/** 把最终主题写到根元素：config-ui 的亮色皮肤与 monaco 的亮色主题都读这个属性。 */
function applyTheme(): void {
  const theme = resolvedTheme();
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR_META[theme]);
}

function notifyPreference(): void {
  for (const listener of [...preferenceListeners]) {
    try {
      listener(preference);
    } catch (error) {
      console.error('[mica] 主题偏好监听器执行失败', error);
    }
  }
}

/** 设置页点选主题：当场生效（换 data-theme）→ 写缓存 → 通知其他窗口。 */
function setPreference(next: ThemePreference): void {
  const normalized = normalizeThemePreference(next);
  const changed = normalized !== preference;
  preference = normalized;
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, normalized);
  } catch {
    // 写不进去只影响下次启动的首帧，不影响本次切换。
  }
  applyTheme();
  if (changed) notifyPreference();
}

// 系统亮暗变化只影响 `auto`；显式选定的主题不被系统带跑。
lightMedia.addEventListener('change', () => {
  if (preference === 'auto') applyTheme();
});

// 多标签同步：storage 事件只发给其他标签页，本标签自己改由 setPreference 处理。
window.addEventListener('storage', (event) => {
  if (event.key !== THEME_CACHE_KEY) return;
  const next = readCachedPreference();
  if (next === preference) return;
  preference = next;
  applyTheme();
  notifyPreference();
});

// 宿主侧接线：页面组件来自共享包，数据源、编辑器与主题能力由这个壳提供。
setConfigWebClient(createHttpConfigWebClient());
setConfigWebEditor(MonacoJsonEditor);
// 首帧脚本已经上过色；这里再跑一次，保证缓存被禁用或脚本被拦截时也落在同一个主题上。
applyTheme();
setConfigWebThemeHost({
  get: () => preference,
  set: setPreference,
  subscribe: (listener) => {
    preferenceListeners.add(listener);
    return () => {
      preferenceListeners.delete(listener);
    };
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigWebApp />
  </React.StrictMode>,
);
