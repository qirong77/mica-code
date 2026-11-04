import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME_PREFERENCE,
  THEMES,
  THEME_PREFERENCES,
  THEME_UI_STATE_KEY,
  isThemeId,
  isThemePreference,
  normalizeThemePreference,
  resolveThemeName,
  themeAppearance,
  themeCanvasColor,
  themeLabel,
} from './theme.js';

describe('theme preference', () => {
  it('recognizes the registered themes plus auto', () => {
    for (const preference of THEME_PREFERENCES) expect(isThemePreference(preference)).toBe(true);
    expect([...THEME_PREFERENCES]).toEqual(['auto', ...THEMES.map((theme) => theme.id)]);
    for (const value of ['system', 'Dark', '', null, undefined, 1, {}, []]) {
      expect(isThemePreference(value)).toBe(false);
    }
  });

  it('normalizes unknown values to the system-following default', () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe('auto');
    expect(normalizeThemePreference('light')).toBe('light');
    expect(normalizeThemePreference('dark')).toBe('dark');
    expect(normalizeThemePreference('mocha')).toBe('mocha');
    expect(normalizeThemePreference('auto')).toBe('auto');
    expect(normalizeThemePreference('system')).toBe('auto');
    expect(normalizeThemePreference(undefined)).toBe('auto');
    expect(normalizeThemePreference(null)).toBe('auto');
  });

  it('resolves auto from the system signal and explicit choices independently of it', () => {
    expect(DEFAULT_LIGHT_THEME).toBe('light');
    expect(DEFAULT_DARK_THEME).toBe('dark');
    expect(resolveThemeName('auto', true)).toBe('light');
    expect(resolveThemeName('auto', false)).toBe('dark');
    expect(resolveThemeName('light', false)).toBe('light');
    expect(resolveThemeName('dark', true)).toBe('dark');
    // 显式选定的主题不看系统：亮色主题在深色系统下仍然是它自己。
    expect(resolveThemeName('mocha', true)).toBe('mocha');
    expect(resolveThemeName('tokyo-night-light', false)).toBe('tokyo-night-light');
    expect(resolveThemeName(undefined, true)).toBe('light');
    expect(resolveThemeName('bogus', false)).toBe('dark');
  });

  it('exposes the stable ui-state key and per-theme meta colors', () => {
    expect(THEME_UI_STATE_KEY).toBe('theme');
    for (const theme of THEMES) {
      expect(theme.canvas).toMatch(/^#[0-9a-f]{6}$/);
      expect(themeCanvasColor(theme.id)).toBe(theme.canvas);
      expect(themeLabel(theme.id)).toBe(theme.label);
      expect(themeAppearance(theme.id)).toBe(theme.appearance);
    }
    expect(new Set(THEMES.map((theme) => theme.canvas)).size).toBe(THEMES.length);
    expect(themeCanvasColor('bogus')).toBe(THEMES[0]!.canvas);
    expect(themeAppearance('bogus')).toBe('dark');
  });

  it('每个主题都有一个明暗相反、互相指向的 pair', () => {
    const byId = new Map(THEMES.map((theme) => [theme.id, theme]));
    for (const theme of THEMES) {
      const pair = byId.get(theme.pair);
      expect(pair, `${theme.id} 的 pair`).toBeDefined();
      expect(pair!.appearance).not.toBe(theme.appearance);
      expect(pair!.pair).toBe(theme.id);
    }
    expect(byId.get(DEFAULT_DARK_THEME)!.appearance).toBe('dark');
    expect(byId.get(DEFAULT_LIGHT_THEME)!.appearance).toBe('light');
  });

  it('isThemeId 只认登记过的 id', () => {
    expect(isThemeId('latte')).toBe(true);
    expect(isThemeId('auto')).toBe(false);
    expect(isThemeId('solarized')).toBe(false);
  });
});
