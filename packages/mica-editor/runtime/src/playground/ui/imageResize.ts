import {calculateZoomLevel} from '@lexical/utils';

export type ImageSize = {width: number; height: number};

const MIN_SIZE = 40;
const MAX_SIZE = Number.MAX_SAFE_INTEGER;

function finiteDimension(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.max(1, value), MAX_SIZE)
    : MIN_SIZE;
}

function finiteDelta(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The editor's content box, in unzoomed CSS pixels. */
export function imageContentWidth(
  root: HTMLElement | null,
  maxWidth?: number,
): number {
  const limit =
    maxWidth !== undefined && Number.isFinite(maxWidth) && maxWidth >= 0
      ? maxWidth
      : Infinity;
  if (root === null) {
    return limit === Infinity ? MIN_SIZE : limit;
  }

  // Force manual zoom: modern browsers report visual pixels in DOMRects too.
  const measuredZoom = calculateZoomLevel(root, true);
  const zoom =
    Number.isFinite(measuredZoom) && measuredZoom > 0 ? measuredZoom : 1;
  const style = root.ownerDocument.defaultView?.getComputedStyle(root);
  const inset = (value: string | undefined) => {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  };
  const rectWidth = root.getBoundingClientRect().width;
  const contentWidth =
    (Number.isFinite(rectWidth) ? rectWidth / zoom : 0) -
    inset(style?.paddingLeft) -
    inset(style?.paddingRight) -
    inset(style?.borderLeftWidth) -
    inset(style?.borderRightWidth);
  return Math.min(limit, Math.max(0, contentWidth));
}

/**
 * Deltas describe movement of the handle, in CSS pixels. Corners always retain
 * the ratio; side handles do so only when requested. When a container cannot fit
 * both 40px minimum edges, fitting its width takes precedence over the minimum.
 */
export function resizeImage(
  size: ImageSize,
  delta: {x: number; y: number},
  direction: string,
  maxWidth: number,
  lockAspectRatio: boolean,
): ImageSize {
  const width = finiteDimension(size.width);
  const height = finiteDimension(size.height);
  const limit =
    Number.isFinite(maxWidth) && maxWidth >= 0
      ? Math.min(Math.floor(maxWidth), MAX_SIZE)
      : MIN_SIZE;
  if (limit === 0) {
    return {width: 0, height: 0};
  }

  const horizontal = /^(e|ne|se)$/.test(direction)
    ? 1
    : /^(w|nw|sw)$/.test(direction)
      ? -1
      : 0;
  const vertical = /^(s|se|sw)$/.test(direction)
    ? 1
    : /^(n|ne|nw)$/.test(direction)
      ? -1
      : 0;
  const dx = horizontal * finiteDelta(delta.x);
  const dy = vertical * finiteDelta(delta.y);

  if ((horizontal !== 0 && vertical !== 0) || lockAspectRatio) {
    // Use the larger proportional change so a corner also responds to a purely
    // vertical drag (and to either axis of keyboard movement).
    const widthScale = dx / width;
    const heightScale = dy / height;
    const change =
      Math.abs(widthScale) >= Math.abs(heightScale) ? widthScale : heightScale;
    const maximumScale = Math.min(limit / width, MAX_SIZE / height);
    const minimumScale = Math.min(
      Math.max(MIN_SIZE / width, MIN_SIZE / height),
      maximumScale,
    );
    const scale = clamp(1 + change, minimumScale, maximumScale);
    return {
      width: Math.min(limit, Math.max(1, Math.round(width * scale))),
      height: Math.min(MAX_SIZE, Math.max(1, Math.round(height * scale))),
    };
  }

  return {
    width: Math.round(clamp(width + dx, Math.min(MIN_SIZE, limit), limit)),
    height: Math.round(clamp(height + dy, MIN_SIZE, MAX_SIZE)),
  };
}
