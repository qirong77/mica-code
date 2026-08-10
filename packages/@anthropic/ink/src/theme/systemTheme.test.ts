import { describe, expect, it } from 'vitest';
import { systemThemeFromOscColor } from './systemTheme.js';

describe('systemThemeFromOscColor', () => {
  it('detects light and dark OSC 11 backgrounds', () => {
    expect(systemThemeFromOscColor('rgb:ffff/ffff/ffff')).toBe('light');
    expect(systemThemeFromOscColor('rgb:0000/0000/0000')).toBe('dark');
    expect(systemThemeFromOscColor('rgb:f5f5/f0f0/eaea')).toBe('light');
  });

  it('ignores malformed terminal responses', () => {
    expect(systemThemeFromOscColor('')).toBeUndefined();
    expect(systemThemeFromOscColor('#ffffff')).toBeUndefined();
    expect(systemThemeFromOscColor('rgb:ffff/ffff')).toBeUndefined();
  });
});
