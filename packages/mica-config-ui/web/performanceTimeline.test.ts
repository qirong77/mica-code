import { describe, expect, it } from 'vitest';
import { rendererTimeline } from './performanceTimeline.js';

describe('renderer timeline page attribution', () => {
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
