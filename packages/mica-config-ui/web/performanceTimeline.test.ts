import { describe, expect, it } from 'vitest';
import { recentTimeline, rendererTimeline, timelineDelay } from './performanceTimeline.js';

describe('renderer timeline page attribution', () => {
  it('does not add timer delay to an overlapping long task', () => {
    expect(timelineDelay({ at: 1000, lag: 150, long: 200, longN: 1, dom: 10 })).toBe(200);
  });

  it('uses sample times for the last thirty seconds across gaps and batched samples', () => {
    const sample = (at: number) => ({ at, lag: 0, long: 0, longN: 0, dom: 10 });
    const points = [sample(1000), sample(90_000), sample(119_999), sample(120_000)];
    expect(recentTimeline(points)).toEqual(points.slice(-2));
    expect(recentTimeline([])).toEqual([]);
  });

  it('keeps the most recently sampled page rather than interleaving independent windows', () => {
    const sample = (at: number, pageId: string) => ({ at, pageId, lag: 0, long: 0, longN: 0, dom: 10 });
    const a = sample(1000, 'a');
    const b = sample(1001, 'b');
    const last = sample(2000, 'a');
    expect(rendererTimeline([a, b, last])).toEqual([a, last]);
  });

  it('can still display samples without a page dimension', () => {
    const samples = [{ at: 1000, lag: 0, long: 0, longN: 0, dom: 10 }];
    expect(rendererTimeline(samples)).toBe(samples);
    expect(rendererTimeline([])).toEqual([]);
  });
});
