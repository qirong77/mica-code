import {calculateZoomLevel} from '@lexical/utils';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {imageContentWidth, resizeImage} from '../src/playground/ui/imageResize';

vi.mock('@lexical/utils', () => ({calculateZoomLevel: vi.fn(() => 1)}));

const landscape = Object.freeze({width: 400, height: 200});

describe('resizeImage', () => {
  it.each([
    ['ne', {x: 80, y: -40}],
    ['se', {x: 80, y: 40}],
    ['sw', {x: -80, y: 40}],
    ['nw', {x: -80, y: -40}],
  ] as const)('keeps the aspect ratio when growing corner %s', (direction, delta) => {
    expect(resizeImage(landscape, delta, direction, 1000, false))
      .toEqual({width: 480, height: 240});
  });

  it.each([
    ['ne', {x: -80, y: 40}],
    ['se', {x: -80, y: -40}],
    ['sw', {x: 80, y: -40}],
    ['nw', {x: 80, y: 40}],
  ] as const)('keeps the aspect ratio when shrinking corner %s', (direction, delta) => {
    expect(resizeImage(landscape, delta, direction, 1000, false))
      .toEqual({width: 320, height: 160});
  });

  it('lets either axis control a corner without requiring diagonal movement', () => {
    expect(resizeImage(landscape, {x: 80, y: 0}, 'se', 1000, false))
      .toEqual({width: 480, height: 240});
    expect(resizeImage(landscape, {x: 0, y: -40}, 'ne', 1000, false))
      .toEqual({width: 480, height: 240});
    expect(resizeImage(landscape, {x: 10, y: 40}, 'se', 1000, false))
      .toEqual({width: 480, height: 240});
  });

  it.each([
    ['e', {x: 80, y: 500}, {width: 480, height: 200}],
    ['w', {x: -80, y: 500}, {width: 480, height: 200}],
    ['s', {x: 500, y: 80}, {width: 400, height: 280}],
    ['n', {x: 500, y: -80}, {width: 400, height: 280}],
  ] as const)('preserves free side resizing by default (%s)', (direction, delta, expected) => {
    expect(resizeImage(landscape, delta, direction, 1000, false)).toEqual(expected);
  });

  it('locks a side handle when requested and constrains its derived width', () => {
    expect(resizeImage(landscape, {x: 80, y: 0}, 'e', 1000, true))
      .toEqual({width: 480, height: 240});
    expect(resizeImage(landscape, {x: 0, y: -80}, 'n', 500, true))
      .toEqual({width: 500, height: 250});
  });

  it('enforces the minimum on both proportional dimensions', () => {
    expect(resizeImage(landscape, {x: -1000, y: -1000}, 'se', 1000, false))
      .toEqual({width: 80, height: 40});
    expect(resizeImage({width: 200, height: 400}, {x: -1000, y: -1000}, 'se', 1000, false))
      .toEqual({width: 40, height: 80});
    expect(resizeImage(landscape, {x: -1000, y: 0}, 'e', 1000, false))
      .toEqual({width: 40, height: 200});
    expect(resizeImage(landscape, {x: 0, y: -1000}, 's', 1000, false))
      .toEqual({width: 400, height: 40});
  });

  it('fits narrow containers even when both minimum edges cannot fit', () => {
    expect(resizeImage(landscape, {x: 1000, y: 1000}, 'se', 30, true))
      .toEqual({width: 30, height: 15});
    expect(resizeImage(landscape, {x: -1000, y: -1000}, 'se', 60, false))
      .toEqual({width: 60, height: 30});
    expect(resizeImage(landscape, {x: -1000, y: 0}, 'e', 30, false))
      .toEqual({width: 30, height: 200});
  });

  it('fits very large originals without breaking their ratio', () => {
    expect(resizeImage({width: 20000, height: 10000}, {x: 100, y: 50}, 'se', 320, true))
      .toEqual({width: 320, height: 160});
    expect(resizeImage({width: 10000, height: 20000}, {x: 100, y: 200}, 'se', 320, true))
      .toEqual({width: 320, height: 640});
  });

  it.each([0, -10, Number.NaN, Infinity, -Infinity])(
    'replaces invalid source dimensions (%s) with 40px',
    value => {
      expect(resizeImage({width: value, height: value}, {x: 0, y: 0}, 'se', 500, false))
        .toEqual({width: 40, height: 40});
    },
  );

  it('repairs each invalid dimension independently and ignores non-finite deltas', () => {
    expect(resizeImage({width: Number.NaN, height: 80}, {x: NaN, y: Infinity}, 'se', 500, true))
      .toEqual({width: 40, height: 80});
    expect(resizeImage(landscape, {x: Infinity, y: NaN}, 'se', 1000, false))
      .toEqual(landscape);
    expect(resizeImage(landscape, {x: 80, y: 0}, 'unknown', 1000, false))
      .toEqual(landscape);
  });

  it('returns finite integers without rounding beyond a fractional width bound', () => {
    const result = resizeImage({width: 191, height: 127}, {x: 500.5, y: 10.25}, 'se', 249.7, false);
    expect(result.width).toBe(249);
    expect(result.height).toBe(166);
    expect(Math.abs(result.height - result.width * 127 / 191)).toBeLessThan(1);
    expect(Number.isInteger(result.width)).toBe(true);
    expect(Number.isInteger(result.height)).toBe(true);
    expect(resizeImage(landscape, {x: 0, y: 0}, 'se', NaN, false))
      .toEqual({width: 40, height: 20});
    expect(resizeImage(landscape, {x: 0, y: 0}, 'se', 0.5, false))
      .toEqual({width: 0, height: 0});
  });

  it('uses the same geometry for one-pixel keyboard steps and larger Shift steps', () => {
    const square = {width: 200, height: 200};
    const keyboardStep = {x: 1, y: 0};
    const shiftStep = {x: 10, y: 0};
    expect(resizeImage(square, keyboardStep, 'se', 800, true))
      .toEqual({width: 201, height: 201});
    expect(resizeImage(square, shiftStep, 'se', 800, true))
      .toEqual({width: 210, height: 210});
    expect(resizeImage(landscape, {x: 0, y: -1}, 'nw', 800, true))
      .toEqual({width: 402, height: 201});
    expect(resizeImage(landscape, {x: -10, y: 0}, 'w', 405, true))
      .toEqual({width: 405, height: 203});
  });
});

function rootWithBox(width: number, overrides: Partial<CSSStyleDeclaration> = {}): HTMLElement {
  return {
    getBoundingClientRect: () => ({width}),
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          paddingLeft: '24px',
          paddingRight: '16px',
          borderLeftWidth: '2px',
          borderRightWidth: '3px',
          ...overrides,
        }),
      },
    },
  } as unknown as HTMLElement;
}

describe('imageContentWidth', () => {
  beforeEach(() => vi.mocked(calculateZoomLevel).mockReturnValue(1));

  it('removes padding and borders after converting the DOMRect out of zoom', () => {
    const root = rootWithBox(960);
    vi.mocked(calculateZoomLevel).mockReturnValue(2);
    expect(imageContentWidth(root)).toBe(435);
    expect(calculateZoomLevel).toHaveBeenCalledWith(root, true);
  });

  it('uses the smaller of the content box and the requested maximum', () => {
    const root = rootWithBox(600);
    expect(imageContentWidth(root, 300)).toBe(300);
    expect(imageContentWidth(root, 1000)).toBe(555);
    expect(imageContentWidth(root, 0)).toBe(0);
  });

  it('falls back to a known maximum or 40px when the editor root is absent', () => {
    expect(imageContentWidth(null, 300)).toBe(300);
    expect(imageContentWidth(null)).toBe(40);
    expect(imageContentWidth(null, NaN)).toBe(40);
    expect(imageContentWidth(rootWithBox(600), NaN)).toBe(555);
  });

  it('handles empty boxes, invalid zoom and non-numeric computed styles', () => {
    expect(imageContentWidth(rootWithBox(20))).toBe(0);
    expect(imageContentWidth(rootWithBox(NaN))).toBe(0);
    vi.mocked(calculateZoomLevel).mockReturnValue(NaN);
    expect(imageContentWidth(rootWithBox(600))).toBe(555);
    expect(imageContentWidth(rootWithBox(600, {
      paddingLeft: 'auto',
      paddingRight: '',
      borderLeftWidth: 'none',
      borderRightWidth: 'NaNpx',
    }))).toBe(600);
  });
});
