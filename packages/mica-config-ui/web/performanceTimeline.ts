import type { ConfigWebPerfTimelinePoint } from '../src/shared/types.js';

/** 一条渲染曲线只描述一个页面；按最近可见采样选择页面，不把多窗口交错当成更高采样率。 */
export function rendererTimeline(points: ConfigWebPerfTimelinePoint[]): ConfigWebPerfTimelinePoint[] {
  const pageId = points.at(-1)?.pageId;
  return pageId ? points.filter((point) => point.pageId === pageId) : points;
}
