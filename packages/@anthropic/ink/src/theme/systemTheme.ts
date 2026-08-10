/**
 * Terminal dark/light mode detection.
 *
 * Detection is based on the terminal's actual background color (queried via
 * OSC 11) rather than the OS appearance setting.
 *
 * Vendored from src/utils/systemTheme.ts for package independence.
 */

export type SystemTheme = 'dark' | 'light';

let cachedSystemTheme: SystemTheme | undefined;

/**
 * Detect theme from $COLORFGBG environment variable (set by some terminals).
 */
function detectFromColorFgBg(): SystemTheme | undefined {
  const colorFgBg = process.env.COLORFGBG;
  if (!colorFgBg) return undefined;
  const parts = colorFgBg.split(';');
  if (parts.length < 2) return undefined;
  const bg = parseInt(parts[parts.length - 1]!, 10);
  // Standard ANSI color indices: 0-7 are dark, 8-15 are bright/light
  if (isNaN(bg)) return undefined;
  return bg >= 8 ? 'light' : 'dark';
}

/** Resolve an OSC 11 response such as `rgb:ffff/ffff/ffff` to a theme. */
export function systemThemeFromOscColor(data: string): SystemTheme | undefined {
  const value = data.trim().toLowerCase();
  const rgb = value.match(/^rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})$/u);
  if (!rgb) return undefined;

  const channel = (hex: string) => Number.parseInt(hex, 16) / (16 ** hex.length - 1);
  const red = channel(rgb[1]!);
  const green = channel(rgb[2]!);
  const blue = channel(rgb[3]!);
  const linear = (component: number) =>
    component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
  const luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  return luminance >= 0.5 ? 'light' : 'dark';
}

/**
 * Get the current terminal theme. Cached after first detection.
 */
export function getSystemThemeName(): SystemTheme {
  if (cachedSystemTheme === undefined) {
    cachedSystemTheme = detectFromColorFgBg() ?? 'dark';
  }
  return cachedSystemTheme;
}

export function setCachedSystemTheme(theme: SystemTheme): void {
  cachedSystemTheme = theme;
}
