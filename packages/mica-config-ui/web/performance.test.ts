import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPerformanceLogs,
  readPerformanceDetails,
  setConfigWebClient,
  supportsPerformance,
} from './api.js';
import type { ConfigWebClient } from './api.js';
import type { ConfigWebPerformanceDetails } from '../src/shared/types.js';

function details(overrides: Partial<ConfigWebPerformanceDetails> = {}): ConfigWebPerformanceDetails {
  return {
    available: true,
    dir: '/tmp/mica-logs',
    files: [{ name: 'perf-20260101.jsonl', bytes: 128, modifiedAt: 1 }],
    totals: { events: 3, errors: 1, warns: 0, slowCalls: 0, samples: 2, hiddenSamples: 0, spanMs: 1000 },
    pending: 0,
    buckets: [],
    timeline: [],
    events: [],
    ...overrides,
  };
}

describe('performance api', () => {
  beforeEach(() => {
    setConfigWebClient(null);
  });

  it('宿主没有能力时 supportsPerformance 为 false', () => {
    setConfigWebClient({} as ConfigWebClient);
    expect(supportsPerformance()).toBe(false);
  });

  it('宿主没有能力时返回显式不可用的详情，而不是抛错', async () => {
    setConfigWebClient({} as ConfigWebClient);
    const result = await readPerformanceDetails();
    expect(result.available).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.dir).toBe('');
  });

  it('宿主没有能力时清空返回 0，不抛错', async () => {
    setConfigWebClient({} as ConfigWebClient);
    expect(await clearPerformanceLogs()).toEqual({ removed: 0 });
  });

  it('宿主有能力时透传参数并返回详情', async () => {
    const calls: unknown[] = [];
    setConfigWebClient({
      readPerformanceDetails: async (options?: { limit?: number }) => {
        calls.push(options);
        return details();
      },
    } as unknown as ConfigWebClient);
    expect(supportsPerformance()).toBe(true);
    const result = await readPerformanceDetails({ limit: 50 });
    expect(calls).toEqual([{ limit: 50 }]);
    expect(result.totals.events).toBe(3);
  });

  it('清空走宿主实现', async () => {
    let cleared = 0;
    setConfigWebClient({
      readPerformanceDetails: async () => details(),
      clearPerformanceLogs: async () => {
        cleared += 1;
        return { removed: 4 };
      },
    } as unknown as ConfigWebClient);
    expect(await clearPerformanceLogs()).toEqual({ removed: 4 });
    expect(cleared).toBe(1);
  });
});
