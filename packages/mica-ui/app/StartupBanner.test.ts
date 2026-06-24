import { stringWidth } from '@anthropic/ink';
import { describe, expect, it } from 'vitest';
import { buildStartupBannerRule, getStartupBannerLayout, getStartupBannerPairLayout } from './StartupBanner.js';

describe('StartupBanner layout', () => {
  it('keeps the current default two-column geometry', () => {
    const layout = getStartupBannerLayout(80);

    expect(layout).toMatchObject({
      frameWidth: 56,
      ruleWidth: 54,
      contentWidth: 52,
      mode: 'two-column',
      columnGap: 4,
      columnWidths: [24, 24],
      singlePairWidth: 52,
    });
    expect(getStartupBannerPairLayout(layout.columnWidths[0])).toEqual({
      labelWidth: 8,
      gapWidth: 2,
      valueWidth: 14,
    });
  });

  it('switches to a single column on narrow terminals', () => {
    const layout = getStartupBannerLayout(38);

    expect(layout).toMatchObject({
      frameWidth: 38,
      contentWidth: 34,
      mode: 'single-column',
      columnGap: 0,
      columnWidths: [34, 0],
      singlePairWidth: 34,
    });
    expect(getStartupBannerPairLayout(layout.singlePairWidth)).toMatchObject({
      labelWidth: 8,
      gapWidth: 2,
      valueWidth: 24,
    });
  });

  it('shrinks pair columns without producing negative widths', () => {
    for (const width of [0, 1, 2, 4, 8, 10]) {
      const layout = getStartupBannerPairLayout(width);
      const safeWidth = Math.max(0, Math.floor(width));

      expect(layout.labelWidth).toBeGreaterThanOrEqual(0);
      expect(layout.gapWidth).toBeGreaterThanOrEqual(0);
      expect(layout.valueWidth).toBeGreaterThanOrEqual(0);
      expect(layout.labelWidth + layout.gapWidth + layout.valueWidth).toBe(safeWidth);
    }
  });

  it('builds border rules with the expected terminal cell width', () => {
    for (const columns of [30, 56, 120]) {
      const layout = getStartupBannerLayout(columns);
      const rule = buildStartupBannerRule(layout, '╭', '╮');

      expect(stringWidth(rule)).toBe(layout.frameWidth);
    }
  });
});
