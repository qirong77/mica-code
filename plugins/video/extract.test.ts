import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFrame, scanFrameDiffs, probeVideo, type FfmpegTools } from './ffmpeg.js';
import { extractFrames, FrameExtractionError, planBySceneChange } from './extract.js';

vi.mock('./ffmpeg.js', async (original) => ({
  ...(await original<typeof import('./ffmpeg.js')>()),
  probeVideo: vi.fn(),
  scanFrameDiffs: vi.fn(),
  extractFrame: vi.fn(),
}));
vi.mock('./frames.js', async (original) => ({
  ...(await original<typeof import('./frames.js')>()),
  readScanCache: vi.fn(async () => null),
  writeScanCache: vi.fn(async () => {}),
}));

const TOOLS: FfmpegTools = { ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe', version: 'test' };

function sceneFixture(signal?: AbortSignal, seconds = 10) {
  const observed: Array<{ outcome: string; code: string }> = [];
  const scan = () =>
    planBySceneChange({
      tools: TOOLS,
      videoPath: '/private/CANARY',
      cacheRoot: '/fake/cache',
      cacheKey: 'test',
      durationSeconds: seconds,
      count: 4,
      rangeStartSeconds: 0,
      rangeLengthSeconds: seconds,
      signal,
      onScenePlan: (value) => observed.push(value),
    });
  return { scan, observed };
}

describe('video scene fallback observations', () => {
  beforeEach(() => {
    vi.mocked(scanFrameDiffs).mockReset();
  });

  it('reports a fixed partial code when scanning fails, without retaining source/error text', async () => {
    vi.mocked(scanFrameDiffs).mockRejectedValue(new Error('PRIVATE_CANARY decode error'));
    const h = sceneFixture();
    expect(await h.scan()).toBeNull();
    expect(h.observed).toEqual([{ outcome: 'partial', code: 'scene_scan_failed' }]);
    expect(JSON.stringify(h.observed)).not.toContain('CANARY');
  });

  it('does not swallow turn cancellation as a successful fallback', async () => {
    const controller = new AbortController();
    vi.mocked(scanFrameDiffs).mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    const h = sceneFixture(controller.signal);
    await expect(h.scan()).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.observed).toEqual([]);
  });

  it('marks an intentional range limit as skipped, not a failure', async () => {
    const h = sceneFixture(undefined, 1000);
    expect(await h.scan()).toBeNull();
    expect(scanFrameDiffs).not.toHaveBeenCalled();
    expect(h.observed).toEqual([{ outcome: 'skipped', code: 'scan_range_limit' }]);
  });
});

describe('video frame extraction without a real ffmpeg', () => {
  let cacheRoot: string;
  let videoPath: string;

  beforeAll(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'mica-video-extract-'));
    // 只需要是个真文件：ffprobe 与解码都被替换掉了，这里要的是 stat 出来的缓存键。
    videoPath = join(cacheRoot, 'fixture.mov');
    await writeFile(videoPath, 'not really a video');
  });
  afterAll(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.mocked(probeVideo).mockReset();
    vi.mocked(probeVideo).mockResolvedValue({
      durationSeconds: 6,
      width: 640,
      height: 360,
      fps: 30,
      videoCodec: 'h264',
      hasAudio: false,
      container: 'mov,mp4',
    });
    vi.mocked(scanFrameDiffs).mockReset();
    vi.mocked(extractFrame).mockReset();
    // 每帧内容按时刻区分：真实 ffmpeg 对同一视频同一时刻的输出也是确定的。
    vi.mocked(extractFrame).mockImplementation(async ({ outputPath, seconds }) => {
      await writeFile(outputPath, Buffer.from(`frame-${seconds}`));
    });
  });

  async function extract(overrides: Record<string, unknown> = {}) {
    return extractFrames({
      tools: TOOLS,
      source: videoPath,
      config: { maxEdge: 1024, cacheLimitMb: 64 },
      cacheRoot,
      cwd: '/',
      ...overrides,
    });
  }

  it('returns local paths with their time points and tells the caller to use read_image', async () => {
    const result = await extract({ at: ['0:02', '0:04'] });

    expect(result.frames.map((frame) => ({ seconds: frame.seconds, at: frame.at }))).toEqual([
      { seconds: 2, at: '0:02.0' },
      { seconds: 4, at: '0:04.0' },
    ]);
    for (const frame of result.frames) {
      expect(frame.path.startsWith(join(cacheRoot, 'frames'))).toBe(true);
      expect((await stat(frame.path)).size).toBe(frame.bytes);
      expect(result.text).toContain(frame.path);
      expect(result.text).toContain(frame.at);
    }
    expect(result.text).toContain('read_image');
    expect(result.text).not.toContain('images follow');
    expect(result.probe.durationSeconds).toBe(6);
  });

  it('falls back to uniform sampling when the scene scan fails', async () => {
    vi.mocked(scanFrameDiffs).mockRejectedValue(new Error('decode failed'));
    const result = await extract();

    expect(result.frames).toHaveLength(4);
    expect(result.plan.notes).toEqual([]);
    expect(result.frames.every((frame) => frame.at && frame.path)).toBe(true);
  });

  it('rejects an explicit invalid count instead of silently using the default', async () => {
    const failure = await extract({ count: 0 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FrameExtractionError);
    expect((failure as FrameExtractionError).code).toBe('invalid_request');
    expect((failure as FrameExtractionError).message).toContain('count 只接受正整数');
  });

  it('rejects an empty source before touching ffprobe', async () => {
    const failure = await extract({ source: '  ' }).catch((error: unknown) => error);
    expect((failure as FrameExtractionError).code).toBe('invalid_request');
    expect(probeVideo).not.toHaveBeenCalled();
  });
});
