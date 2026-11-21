/**
 * 语雀把「＋」和「删除」拆成两个独立按钮后，各自的落点由这里算：
 * 「＋」贴在轴尾（行下边界 / 列右边界）的外侧，「删除」放在垂直方向的表格外缘，
 * 两者不共用一张胶囊，也不会压在正文上。
 */
export type BandAxis = 'row' | 'column';

export type BandActionPoint = {left: number; top: number};

export type BandActions = {add: BandActionPoint; remove: BandActionPoint | null};

export type BandActionsInput = {
  axis: BandAxis;
  /** 该轴的总条数（总行数或总列数）。 */
  count: number;
  /** 目标条带的首尾索引（含）。 */
  startIndex: number;
  endIndex: number;
  /** 该轴每个边界的像素位置，长度是 count + 1。 */
  edges: readonly number[];
  /** 可见区域在该轴上的起止（滚动容器或视口的交集）。 */
  clipStart: number;
  clipEnd: number;
  /** 把手所在位置：行用 railLeft，列用 railTop。 */
  rail: number;
  /** The perpendicular handle rail and first visible cell edge. */
  crossRail: number;
  crossStart: number;
  viewport: {width: number; height: number};
  size?: number;
};

export const BAND_ACTION_SIZE = 22;
/** 与把手之间留的空隙。 */
const BAND_ACTION_GAP = 4;
/** 视口边缘留白。 */
const BAND_ACTION_INSET = 2;
/** 列按钮压在列线（rail）上方一点点，和列边界加号同一水平带。 */
const RAIL_LIFT = 4;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function placeBandActions(input: BandActionsInput): BandActions | null {
  const size = input.size ?? BAND_ACTION_SIZE;
  const {axis, edges, clipStart, clipEnd, rail, crossRail, crossStart, viewport} = input;
  const start = Math.max(edges[input.startIndex] ?? clipStart, clipStart);
  const end = Math.min(edges[input.endIndex + 1] ?? clipEnd, clipEnd);
  // 滚动后只剩一条缝的条带不再挂按钮：它已经指不准目标了。
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < size / 2) return null;

  const maxLeft = Math.max(BAND_ACTION_INSET, viewport.width - size - BAND_ACTION_INSET);
  const maxTop = Math.max(BAND_ACTION_INSET, viewport.height - size - BAND_ACTION_INSET);
  const add: BandActionPoint = axis === 'row'
    ? {left: clamp(rail - BAND_ACTION_GAP - size, BAND_ACTION_INSET, maxLeft), top: clamp(end - size / 2, BAND_ACTION_INSET, maxTop)}
    : {left: clamp(end - size / 2, BAND_ACTION_INSET, maxLeft), top: clamp(rail - RAIL_LIFT, BAND_ACTION_INSET, maxTop)};

  // 只剩一行/一列时没有可删的东西；轴首滚出可见区后，删除按钮也不再指向真实目标。
  const bandLength = input.endIndex - input.startIndex + 1;
  const leading = edges[input.startIndex] ?? clipStart;
  const removable = input.count - bandLength >= 1 && leading >= clipStart - 0.5 &&
    (axis === 'column' || end - start >= size + BAND_ACTION_GAP);
  if (!removable) return {add, remove: null};
  // Row deletion sits above the table's leading corner; column deletion sits
  // to its left. The axes stay separate, and no button covers a body cell.
  const remove: BandActionPoint = axis === 'row'
    ? {left: clamp(crossStart + 6, BAND_ACTION_INSET, maxLeft), top: clamp(crossRail - BAND_ACTION_GAP - size, BAND_ACTION_INSET, maxTop)}
    : {left: clamp(crossRail - BAND_ACTION_GAP - size, BAND_ACTION_INSET, maxLeft), top: clamp(crossStart + 6, BAND_ACTION_INSET, maxTop)};
  return {add, remove};
}
