import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PluginApiError,
  type PluginApiHandler,
  type PluginApiMethod,
  type PluginDataApi,
} from '@packages/mica-plugin/index.js';
import createApi from './api.js';
import { detectFfmpeg, extractFrame, probeVideo, scanFrameDiffs, type FfmpegTools } from './ffmpeg.js';

vi.mock('./ffmpeg.js', async (original) => ({
  ...(await original<typeof import('./ffmpeg.js')>()),
  detectFfmpeg: vi.fn(),
  probeVideo: vi.fn(),
  scanFrameDiffs: vi.fn(),
  extractFrame: vi.fn(),
}));

const TOOLS: FfmpegTools = { ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe', version: 'test' };
const PROBE = {
  durationSeconds: 6,
  width: 640,
  height: 360,
  fps: 30,
  videoCodec: 'h264',
  hasAudio: false,
  container: 'mov,mp4',
};

function createHandler(): PluginApiHandler {
  return createApi({
    pluginId: 'video',
    pluginVersion: '1.0.0',
    data: {} as PluginDataApi,
    settings: { get: () => ({}) },
  });
}

async function call(
  handler: PluginApiHandler,
  options: {
    method?: PluginApiMethod;
    path?: string;
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<Record<string, any>> {
  const response = await handler.handle({
    method: options.method ?? 'POST',
    path: (options.path ?? 'frames').split('/').filter(Boolean),
    query: {},
    body: options.body,
    signal: options.signal ?? new AbortController().signal,
  });
  return response.body as Record<string, any>;
}

async function expectFailure(promise: Promise<unknown>, status: number, code: string): Promise<PluginApiError> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof PluginApiError)) throw new Error(`期望 PluginApiError，实际是：${String(error)}`);
  expect({ status: error.status, code: error.code }).toEqual({ status, code });
  return error;
}

describe('video plugin API', () => {
  let home: string;
  let videoPath: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'mica-video-api-'));
    videoPath = join(home, 'fixture.mov');
    await writeFile(videoPath, 'not really a video');
    vi.stubEnv('MICA_HOME', home);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    // 缓存跟着 MICA_HOME 走：每个测试文件一个临时目录，不会命中别人的帧。
    vi.mocked(detectFfmpeg).mockReset();
    vi.mocked(detectFfmpeg).mockResolvedValue(TOOLS);
    vi.mocked(probeVideo).mockReset();
    vi.mocked(probeVideo).mockResolvedValue({ ...PROBE });
    vi.mocked(scanFrameDiffs).mockReset();
    vi.mocked(extractFrame).mockReset();
    vi.mocked(extractFrame).mockImplementation(async ({ outputPath, seconds }) => {
      await writeFile(outputPath, Buffer.from(`frame-${seconds}`));
    });
  });

  it('serves every endpoint it documents, and nothing else', async () => {
    const handler = createHandler();
    expect(handler.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual(['POST /frames']);

    for (const endpoint of handler.endpoints) {
      // 文档里有的端点必须进到处理分支：空请求体应该报参数问题，而不是「没有这个端点」。
      const error = await Promise.resolve(
        handler.handle({
          method: endpoint.method,
          path: endpoint.path.split('/').filter(Boolean),
          query: {},
          body: {},
          signal: new AbortController().signal,
        }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PluginApiError);
      expect((error as PluginApiError).code).not.toBe('not_found');
    }

    await expectFailure(call(handler, { path: 'clip' }), 404, 'not_found');
    await expectFailure(call(handler, { method: 'GET' }), 405, 'method_not_allowed');
  });

  it('tells the model the 30s limit, the local-file rule and the read_image step', () => {
    const handler = createHandler();
    const guide = String(handler.guide);
    expect(String(handler.description)).toContain('/plugin/video/api');
    expect(guide).toContain('30 秒');
    expect(guide).toContain('下载到本地');
    expect(guide).toContain('read_image');
    expect(guide).toContain('3–6 张');
    expect(guide).toContain('时间不是序号');
  });

  it('maps frames to their time points and returns local paths only', async () => {
    const body = await call(createHandler(), { body: { source: videoPath, at: ['0:02', '0:04'] } });

    expect(body.video).toEqual({
      source: videoPath,
      durationSeconds: 6,
      width: 640,
      height: 360,
      fps: 30,
      hasAudio: false,
    });
    expect(body.frames.map((frame: { at: string; seconds: number }) => [frame.at, frame.seconds])).toEqual([
      ['0:02.0', 2],
      ['0:04.0', 4],
    ]);
    for (const frame of body.frames as Array<{ path: string }>) {
      // 响应里只有路径：图片要模型自己用 read_image 读。
      expect(frame.path.startsWith(join(home, 'plugin-data', 'video', 'frames'))).toBe(true);
      expect(existsSync(frame.path)).toBe(true);
      expect(body.text).toContain(frame.path);
    }
    expect(body.text).toContain('read_image');
  });

  it('rejects a missing source with 400 before touching the video', async () => {
    const error = await expectFailure(call(createHandler(), { body: {} }), 400, 'invalid_request');
    expect(error.message).toContain('source');
  });

  it('rejects an invalid count instead of silently sampling the default number', async () => {
    const error = await expectFailure(
      call(createHandler(), { body: { source: videoPath, count: 0 } }),
      400,
      'invalid_request',
    );
    expect(error.message).toContain('count 只接受正整数');
  });

  it('rejects a non-string at list before it can be coerced into [object Object]', async () => {
    const error = await expectFailure(
      call(createHandler(), { body: { source: videoPath, at: [{ seconds: 3 }] } }),
      400,
      'invalid_request',
    );
    expect(error.message).toContain('at');
  });

  it('rejects an unparsable time point as a parameter problem, not a decode failure', async () => {
    const error = await expectFailure(
      call(createHandler(), { body: { source: videoPath, at: ['nope'] } }),
      400,
      'invalid_request',
    );
    expect(error.message).toContain('无法解析的时间点');
  });

  it('reports a missing ffmpeg as 503 with an actionable hint', async () => {
    vi.mocked(detectFfmpeg).mockResolvedValue(null);
    const error = await expectFailure(call(createHandler(), { body: { source: videoPath } }), 503, 'ffmpeg_missing');
    expect(error.message).toContain('brew install ffmpeg');
  });

  it('passes cancellation and timeouts through instead of rewriting them as 400/500', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Plugin api request timed out', 'TimeoutError'));
    const failure = await call(createHandler(), { body: { source: videoPath }, signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ name: 'TimeoutError' });
  });

  it('does not swallow a timeout that lands mid-extraction', async () => {
    const controller = new AbortController();
    vi.mocked(extractFrame).mockImplementation(async () => {
      controller.abort(new DOMException('Plugin api request timed out', 'TimeoutError'));
      throw controller.signal.reason;
    });
    const failure = await call(createHandler(), {
      // 刻意用一个前面没抽过的时刻：命中缓存就不会再调用 extractFrame，这条测试就白写了。
      body: { source: videoPath, at: ['0:05'] },
      signal: controller.signal,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'TimeoutError' });
  });
});
