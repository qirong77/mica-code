import {describe, expect, it} from 'vitest';

import {
  MENU_GAP,
  MENU_MIN_WIDTH,
  VIEWPORT_PADDING,
  placeBlockMenu,
  placeSubmenu,
} from '../src/playground/plugins/DraggableBlockPlugin/blockMenuPlacement';

const viewport = {width: 1440, height: 900};
const grip = {left: 300, top: 200, right: 324, bottom: 224};

function rect(left: number, top: number, width: number, height: number) {
  return {left, top, right: left + width, bottom: top + height};
}

describe('placeBlockMenu', () => {
  it('opens beside the grip without covering its click target', () => {
    const block = rect(330, 200, 700, 48);
    const placement = placeBlockMenu({
      anchor: grip,
      blockRect: block,
      size: {width: 180, height: 300},
      viewport,
    });
    expect(placement).toEqual({left: grip.right + MENU_GAP, top: 200});
  });

  it('keeps a tall block’s card beside the block instead of mirroring it above', () => {
    // A code block running past the window: the old rule put the card at
    // `block.top - height - gap`, which landed on the document title.
    const block = rect(330, 600, 700, 700);
    const placement = placeBlockMenu({
      anchor: {left: 300, top: 600, right: 324, bottom: 624},
      blockRect: block,
      size: {width: 180, height: 296},
      viewport,
    });
    expect(placement.top).toBeGreaterThan(VIEWPORT_PADDING * 10);
    expect(placement.top + 296).toBeLessThanOrEqual(viewport.height - VIEWPORT_PADDING);
    expect(placement.top).toBe(viewport.height - 296 - VIEWPORT_PADDING);
  });

  it('slides the card up when the block starts near the bottom of the window', () => {
    const block = rect(330, 840, 700, 40);
    const placement = placeBlockMenu({
      anchor: {left: 300, top: 840, right: 324, bottom: 864},
      blockRect: block,
      size: {width: 180, height: 300},
      viewport,
    });
    expect(placement.top).toBe(viewport.height - 300 - VIEWPORT_PADDING);
    expect(placement.top).toBeLessThan(block.top);
  });

  it('never leaves the top edge, even when the whole card cannot fit', () => {
    const placement = placeBlockMenu({
      anchor: grip,
      blockRect: rect(330, 4, 700, 40),
      size: {width: 180, height: 1200},
      viewport,
    });
    expect(placement.top).toBe(VIEWPORT_PADDING);
  });

  it('flips to the grip’s left side at the right edge', () => {
    const placement = placeBlockMenu({
      anchor: {left: 1380, top: 200, right: 1404, bottom: 224},
      blockRect: rect(1390, 200, 40, 24),
      size: {width: 180, height: 300},
      viewport,
    });
    expect(placement.left).toBe(1380 - 180 - MENU_GAP);
    expect(placement.left + 180).toBeLessThanOrEqual(1380);
  });

  it('keeps the grip visible when the right side is unavailable', () => {
    const placement = placeBlockMenu({
      anchor: {left: 24, top: 200, right: 48, bottom: 224},
      blockRect: rect(52, 200, 240, 24),
      size: {width: 180, height: 300},
      viewport: {width: 240, height: 900},
    });
    expect(placement.left).toBe(52);
    expect(placement.left).toBeGreaterThanOrEqual(48 + MENU_GAP);
  });

  it('keeps the card out of the notebook toolbar and status bar', () => {
    const placement = placeBlockMenu({
      anchor: grip,
      blockRect: rect(330, 0, 700, 40),
      size: {width: 180, height: 300},
      viewport,
      safeArea: {top: 52, bottom: 28},
    });
    expect(placement.top).toBe(52);
    expect(placement.top + 300).toBeLessThanOrEqual(viewport.height - 28);
  });

  it('keeps its design width when the measured card is narrower', () => {
    const placement = placeBlockMenu({
      anchor: {left: 1400, top: 200, right: 1424, bottom: 224},
      blockRect: rect(1400, 200, 40, 24),
      size: {width: 120, height: 300},
      viewport,
    });
    expect(placement.left).toBe(1400 - MENU_MIN_WIDTH - MENU_GAP);
    expect(placement.left + MENU_MIN_WIDTH).toBeLessThanOrEqual(1400);
  });
});

describe('placeSubmenu', () => {
  const main = rect(292, 200, 180, 300);

  it('opens to the right of the card, aligned with the hovered row', () => {
    const placement = placeSubmenu({
      row: rect(292, 236, 180, 36),
      main,
      size: {width: 180, height: 296},
      viewport,
    });
    expect(placement.left).toBe(main.right + MENU_GAP);
    expect(placement.top).toBe(236 - VIEWPORT_PADDING);
  });

  it('flips to the card’s left side without double-counting its own width', () => {
    const nearRight = rect(1240, 200, 180, 300);
    const placement = placeSubmenu({
      row: rect(1240, 236, 180, 36),
      main: nearRight,
      size: {width: 180, height: 296},
      viewport,
    });
    expect(placement.left).toBe(nearRight.left - 180 - MENU_GAP);
    expect(placement.left + 180).toBeLessThanOrEqual(nearRight.left);
  });

  it('stays on screen when neither side of the card has room', () => {
    const centred = rect(720, 200, 180, 300);
    const placement = placeSubmenu({
      row: rect(720, 236, 180, 36),
      main: centred,
      size: {width: 180, height: 296},
      viewport,
    });
    expect(placement.left).toBeGreaterThanOrEqual(VIEWPORT_PADDING);
    expect(placement.left + 180).toBeLessThanOrEqual(viewport.width - VIEWPORT_PADDING);
  });

  it('does not expand into the notebook style panel on the right', () => {
    const nearRight = rect(1000, 200, 180, 300);
    const placement = placeSubmenu({
      row: rect(1000, 236, 180, 36),
      main: nearRight,
      size: {width: 180, height: 296},
      viewport,
      safeArea: {right: 320},
    });
    expect(placement.left + 180).toBeLessThanOrEqual(viewport.width - 320);
  });

  it('clamps the bottom edge for a long submenu opened from a low row', () => {
    const placement = placeSubmenu({
      row: rect(292, 460, 180, 36),
      main,
      size: {width: 180, height: 500},
      viewport,
    });
    expect(placement.top).toBe(viewport.height - 500 - VIEWPORT_PADDING);
  });
});
