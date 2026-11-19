import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoFramesTool } from './VideoFramesTool.js';
import { scanFrameDiffs } from './ffmpeg.js';

vi.mock('./ffmpeg.js', async (original) => ({
  ...await original<typeof import('./ffmpeg.js')>(), scanFrameDiffs: vi.fn(),
}));
vi.mock('./frames.js', async (original) => ({
  ...await original<typeof import('./frames.js')>(), readScanCache: vi.fn(async () => null),
  writeScanCache: vi.fn(async () => {}),
}));

function fixture(signal?: AbortSignal, seconds = 10) {
  const observed: Array<{ outcome: string; code: string }> = [];
  const tool = new VideoFramesTool({
    getConfig: () => ({ maxEdge: 1024, cacheLimitMb: 64 }), onMissingFfmpeg() {},
    onScenePlan: (value) => observed.push(value),
  });
  const scan = () => (tool as unknown as { planBySceneChange(input: object): Promise<unknown> }).planBySceneChange({
    tools: { ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' },
    videoPath: '/private/CANARY', cacheRoot: '/fake/cache', cacheKey: 'test', durationSeconds: seconds,
    count: 4, rangeStartSeconds: 0, rangeLengthSeconds: seconds, signal,
  });
  return { scan, observed };
}

describe('video scene fallback observations', () => {
  beforeEach(() => { vi.mocked(scanFrameDiffs).mockReset(); });
  it('reports a fixed partial code when scanning fails, without retaining source/error text', async () => {
    vi.mocked(scanFrameDiffs).mockRejectedValue(new Error('PRIVATE_CANARY decode error'));
    const h = fixture();
    expect(await h.scan()).toBeNull();
    expect(h.observed).toEqual([{ outcome: 'partial', code: 'scene_scan_failed' }]);
    expect(JSON.stringify(h.observed)).not.toContain('CANARY');
  });
  it('does not swallow turn cancellation as a successful fallback', async () => {
    const controller = new AbortController();
    vi.mocked(scanFrameDiffs).mockImplementation(async () => { controller.abort(); throw controller.signal.reason; });
    const h = fixture(controller.signal);
    await expect(h.scan()).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.observed).toEqual([]);
  });
  it('marks an intentional range limit as skipped, not a failure', async () => {
    const h = fixture(undefined, 1000);
    expect(await h.scan()).toBeNull();
    expect(scanFrameDiffs).not.toHaveBeenCalled();
    expect(h.observed).toEqual([{ outcome: 'skipped', code: 'scan_range_limit' }]);
  });
});
