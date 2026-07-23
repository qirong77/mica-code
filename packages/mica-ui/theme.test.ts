import { describe, expect, it } from 'vitest';
import { themeColors } from './theme.js';

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(left: string, right: string): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('themeColors', () => {
  it('keeps the user message surface visible on common dark terminal backgrounds', () => {
    expect(contrastRatio(themeColors.surfaceUser, '#282828')).toBeGreaterThanOrEqual(1.2);
    expect(contrastRatio(themeColors.surfaceUser, '#1E1E1E')).toBeGreaterThanOrEqual(1.2);
  });
});
