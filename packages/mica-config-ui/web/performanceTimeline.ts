import type { ConfigWebPerfTimelinePoint } from '../src/shared/types.js';

/** 一条渲染曲线只描述一个页面；按最近可见采样选择页面，不把多窗口交错当成更高采样率。 */
export function rendererTimeline(points: ConfigWebPerfTimelinePoint[]): ConfigWebPerfTimelinePoint[] {
  const pageId = points.at(-1)?.pageId;
  return pageId ? points.filter((point) => point.pageId === pageId) : points;
}

/** 定时器延迟可能与 longtask 重叠，只取较大值，避免把同一次阻塞叠加两遍。 */
export function timelineDelay(point: ConfigWebPerfTimelinePoint): number {
  return Math.max(point.lag, point.long);
}

export function recentTimeline(points: ConfigWebPerfTimelinePoint[], spanMs = 30_000): ConfigWebPerfTimelinePoint[] {
  const end = points.at(-1)?.at;
  return end === undefined ? [] : points.filter((point) => point.at > end - spanMs);
}
