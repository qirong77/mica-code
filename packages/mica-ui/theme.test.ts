import { describe, expect, it } from 'vitest';
import { getTheme } from '../@anthropic/ink/src/theme/theme-types.js';
import { themeColors } from './theme.js';

describe('themeColors', () => {
  it('uses only keys available in Ink light and dark palettes', () => {
    const light = getTheme('light') as Record<string, string>;
    const dark = getTheme('dark') as Record<string, string>;

    for (const token of Object.values(themeColors)) {
      expect(light[token], `missing light theme token: ${token}`).toBeDefined();
      expect(dark[token], `missing dark theme token: ${token}`).toBeDefined();
    }
  });

  it('keeps surfaces semantic so light terminals do not receive dark fills', () => {
    expect(themeColors.surfaceUser).toBe('userMessageBackground');
    expect(themeColors.surfaceSelected).toBe('messageActionsBackground');
    expect(themeColors.text).toBe('text');
  });
});
