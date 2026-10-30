import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COLOR_META,
  THEME_PREFERENCES,
  THEME_UI_STATE_KEY,
  isThemePreference,
  normalizeThemePreference,
  resolveThemeName,
} from './theme.js';

describe('theme preference', () => {
  it('only recognizes the three known preferences', () => {
    for (const preference of THEME_PREFERENCES) expect(isThemePreference(preference)).toBe(true);
    for (const value of ['system', 'Dark', '', null, undefined, 1, {}, []]) {
      expect(isThemePreference(value)).toBe(false);
    }
  });

  it('normalizes unknown values to the system-following default', () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe('auto');
    expect(normalizeThemePreference('light')).toBe('light');
    expect(normalizeThemePreference('dark')).toBe('dark');
    expect(normalizeThemePreference('auto')).toBe('auto');
    expect(normalizeThemePreference('system')).toBe('auto');
    expect(normalizeThemePreference(undefined)).toBe('auto');
    expect(normalizeThemePreference(null)).toBe('auto');
  });

  it('resolves auto from the system signal and explicit choices independently of it', () => {
    expect(resolveThemeName('auto', true)).toBe('light');
    expect(resolveThemeName('auto', false)).toBe('dark');
    expect(resolveThemeName('light', false)).toBe('light');
    expect(resolveThemeName('dark', true)).toBe('dark');
    expect(resolveThemeName(undefined, true)).toBe('light');
    expect(resolveThemeName('bogus', false)).toBe('dark');
  });

  it('exposes the stable ui-state key and per-theme meta colors', () => {
    expect(THEME_UI_STATE_KEY).toBe('theme');
    expect(THEME_COLOR_META.light).toMatch(/^#[0-9a-f]{6}$/);
    expect(THEME_COLOR_META.dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(THEME_COLOR_META.light).not.toBe(THEME_COLOR_META.dark);
  });
});
