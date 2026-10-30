import { useEffect, useState } from 'react';
import {
  DEFAULT_THEME_PREFERENCE,
  normalizeThemePreference,
  type ThemePreference,
} from '@packages/mica-web-shared/index.js';

/**
 * 设置页的主题能力——由宿主提供，页面只负责展示与转发。
 *
 * 主题偏好是「这台运行时/这个宿主」的界面状态，而不是 config.json 里的 agent 配置：
 * - 桌面宿主把它存在运行时界面状态（ui-state 的 `theme` 键），所有窗口和其他设备同步；
 * - 浏览器宿主（apps/config-web）没有运行时界面状态，就存在页面自己的 localStorage。
 *
 * 没注册宿主的页面（理论上不该渲染 Appearance 页）不显示入口：宁可没有这一页，
 * 也不给一个点了没反应的单选。
 */
export type ConfigWebThemeHost = {
  get(): ThemePreference;
  set(preference: ThemePreference): void;
  /** 偏好变化时回调（别的窗口改了、或当前窗口自己改）。返回取消订阅函数。 */
  subscribe(listener: (preference: ThemePreference) => void): () => void;
};

export type { ThemePreference };

export type ThemeOption = {
  value: ThemePreference;
  label: string;
  description: string;
};

/** 单选卡的文案：页面与测试共用，避免文案散在 JSX 里。 */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'auto', label: '跟随系统', description: '随 macOS / 系统的浅色与深色模式自动切换' },
  { value: 'light', label: '浅色', description: '亮色界面，基于 DeepSeek harness 设计系统配色' },
  { value: 'dark', label: '深色', description: '暗色界面，当前的 Darcula（VSCode）配色' },
] as const;

let host: ConfigWebThemeHost | null = null;

/** 由宿主在渲染配置页之前注册；传 `null` 表示这一页不可用。 */
export function setConfigWebThemeHost(next: ConfigWebThemeHost | null): void {
  host = next;
}

export function hasConfigWebThemeHost(): boolean {
  return host !== null;
}

function readPreference(): ThemePreference {
  return host ? normalizeThemePreference(host.get()) : DEFAULT_THEME_PREFERENCE;
}

/**
 * 当前窗口的主题偏好。别的窗口（或宿主自己的系统跟随）改变偏好时跟着重渲染，
 * 所以两个窗口同时开着设置页也不会各说各话。
 */
export function useThemePreference(): {
  preference: ThemePreference;
  setPreference(preference: ThemePreference): void;
  available: boolean;
} {
  const [preference, setLocalPreference] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    if (!host) return undefined;
    setLocalPreference(readPreference());
    return host.subscribe((next) => setLocalPreference(normalizeThemePreference(next)));
  }, []);

  return {
    preference,
    available: host !== null,
    setPreference(next: ThemePreference) {
      if (!host) return;
      setLocalPreference(normalizeThemePreference(next));
      host.set(normalizeThemePreference(next));
    },
  };
}
