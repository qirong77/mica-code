/**
 * Placement maths for the block menu, kept away from React so the geometry can
 * be tested directly.
 *
 * Yuque anchors the card at the grip: its left edge lines up with the handle
 * and its top edge lines up with the block's first line. The card never jumps
 * above its block — when the block sits near the bottom of the window the card
 * slides up just enough to stay visible. The old rule ("open below the block,
 * otherwise mirror it above") threw the card at the top of the page for any
 * tall block, covering the document title and the toolbar.
 */

export type PlacementRect = {left: number; top: number; right: number; bottom: number};
export type PlacementSize = {width: number; height: number};
export type PlacementViewport = {width: number; height: number};
export type Placement = {left: number; top: number};

/** Distance the card keeps from every window edge. */
export const VIEWPORT_PADDING = 8;
/** Gap between the card and its submenu, and between the grip and the card. */
export const MENU_GAP = 4;
/** The card's design width; narrower measurements still reserve this. */
export const MENU_MIN_WIDTH = 180;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** Keep a panel horizontally on screen, preferring its requested left edge. */
function clampLeft(left: number, width: number, viewportWidth: number): number {
  return clamp(left, VIEWPORT_PADDING, viewportWidth - width - VIEWPORT_PADDING);
}

/**
 * Where the main card goes.
 *
 * `anchor` is the grip, `blockRect` the block it acts on. The card starts at
 * the grip's left edge pulled slightly into the gutter, and at the block's top.
 */
export function placeBlockMenu({
  anchor,
  blockRect,
  size,
  viewport,
}: {
  anchor: PlacementRect;
  blockRect: PlacementRect;
  size: PlacementSize;
  viewport: PlacementViewport;
}): Placement {
  const width = Math.max(size.width, MENU_MIN_WIDTH);
  const height = size.height;
  const left = clampLeft(anchor.left - VIEWPORT_PADDING, width, viewport.width);

  let top = blockRect.top;
  if (top + height > viewport.height - VIEWPORT_PADDING) {
    top = viewport.height - height - VIEWPORT_PADDING;
  }
  top = Math.max(VIEWPORT_PADDING, top);
  return {left, top};
}

/**
 * Where a submenu goes: to the right of the card, aligned so its first row
 * matches the hovered row. It flips to the card's left side when the right edge
 * has no room, and only then falls back to being clamped inside the window.
 */
export function placeSubmenu({
  row,
  main,
  size,
  viewport,
}: {
  /** The hovered row inside the main card. */
  row: PlacementRect;
  /** The main card. */
  main: PlacementRect;
  size: PlacementSize;
  viewport: PlacementViewport;
}): Placement {
  const width = Math.max(size.width, MENU_MIN_WIDTH);
  const height = size.height;

  const rightOfCard = main.right + MENU_GAP;
  let left: number;
  if (rightOfCard + width <= viewport.width - VIEWPORT_PADDING) {
    left = rightOfCard;
  } else {
    const leftOfCard = main.left - width - MENU_GAP;
    left = leftOfCard >= VIEWPORT_PADDING
      ? leftOfCard
      : clampLeft(rightOfCard, width, viewport.width);
  }

  // The card's top padding sits above its first row; cancelling it lines the
  // submenu's first row up with the row the pointer is on.
  let top = row.top - VIEWPORT_PADDING;
  if (top + height > viewport.height - VIEWPORT_PADDING) {
    top = viewport.height - height - VIEWPORT_PADDING;
  }
  top = Math.max(VIEWPORT_PADDING, top);
  return {left, top};
}
