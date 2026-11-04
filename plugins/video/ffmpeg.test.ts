import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFfmpeg, extractFrame, probeVideo, type FfmpegTools } from './ffmpeg.js';
import { ensureFrames, videoCacheKey } from './frames.js';
import { planFrames } from './plan.js';
import { prepareImageForApi } from '@packages/mica-common/index.js';

/**
 * 真起 ffmpeg。没装就整组跳过而不是伪造——一条假通过的测试比没有更糟。
 */
const tools = await detectFfmpeg();

describe.skipIf(!tools)('ffmpeg 集成', () => {
  let workDir: string;
  let tools2: FfmpegTools;

  beforeAll(async () => {
    tools2 = tools!;
    workDir = await mkdtemp(join(tmpdir(), 'mica-video-'));
    makeVideo(join(workDir, 'landscape.mp4'), '1280x720', 6, { audio: true });
    makeVideo(join(workDir, 'portrait.mp4'), '720x1280', 3, { audio: false });
    // 纯音频：没有视频流，必须报错而不是返回一张黑图。
    execFileSync(tools2.ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'aac',
      join(workDir, 'audio.m4a'),
      '-y',
    ]);
  }, 60_000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('读出元信息', async () => {
    const probe = await probeVideo(tools2.ffprobePath, join(workDir, 'landscape.mp4'));
    expect(probe.durationSeconds).toBeCloseTo(6, 0);
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.fps).toBeCloseTo(30, 0);
    expect(probe.hasAudio).toBe(true);
    expect(probe.videoCodec).toBe('h264');
  });

  it('没有音频流时如实报告', async () => {
    const probe = await probeVideo(tools2.ffprobePath, join(workDir, 'portrait.mp4'));
    expect(probe.hasAudio).toBe(false);
    expect(probe.width).toBe(720);
  });

  it('纯音频文件报错而不是给一张黑图', async () => {
    await expect(probeVideo(tools2.ffprobePath, join(workDir, 'audio.m4a'))).rejects.toThrow(/没有视频流/);
  });

  it('横屏帧按长边缩放', async () => {
    const out = join(workDir, 'frame-landscape.jpg');
    await extractFrame({
      ffmpegPath: tools2.ffmpegPath,
      videoPath: join(workDir, 'landscape.mp4'),
      seconds: 2.5,
      maxEdge: 1024,
      outputPath: out,
    });
    const probe = await probeVideo(tools2.ffprobePath, out);
    expect(Math.max(probe.width, probe.height)).toBe(1024);
    expect(probe.width).toBe(1024);
    expect(probe.height).toBe(576);
  });

  it('竖屏帧同样按长边缩放', async () => {
    const out = join(workDir, 'frame-portrait.jpg');
    await extractFrame({
      ffmpegPath: tools2.ffmpegPath,
      videoPath: join(workDir, 'portrait.mp4'),
      seconds: 1,
      maxEdge: 512,
      outputPath: out,
    });
    const probe = await probeVideo(tools2.ffprobePath, out);
    expect(probe.height).toBe(512);
    expect(probe.width).toBe(288);
  });

  it('抽出来的帧能被图片链路识别', async () => {
    const out = join(workDir, 'frame-valid.jpg');
    await extractFrame({
      ffmpegPath: tools2.ffmpegPath,
      videoPath: join(workDir, 'landscape.mp4'),
      seconds: 1,
      maxEdge: 512,
      outputPath: out,
    });
    const processed = await prepareImageForApi(await readFile(out));
    expect(processed.mediaType).toBe('image/jpeg');
    expect(processed.width).toBeGreaterThan(0);
  });

  it('抽帧层不兜越界时刻，给出可读错误', async () => {
    const out = join(workDir, 'frame-beyond.jpg');
    await expect(
      extractFrame({
        ffmpegPath: tools2.ffmpegPath,
        videoPath: join(workDir, 'landscape.mp4'),
        seconds: 999,
        maxEdge: 512,
        outputPath: out,
      }),
    ).rejects.toThrow(/取不到画面/);
  });

  it('plan 夹到结尾后的时刻真的能取到帧', async () => {
    const videoPath = join(workDir, 'landscape.mp4');
    const info = await stat(videoPath);
    const probe = await probeVideo(tools2.ffprobePath, videoPath);
    const plan = planFrames({
      durationSeconds: probe.durationSeconds,
      defaultCount: 4,
      at: ['99:00'],
    });
    // 夹到时长末尾而不是 duration 本身：`-ss` 等于时长时一帧都取不到。
    expect(plan.frames[0]!.seconds).toBeLessThan(probe.durationSeconds);

    const frames = await ensureFrames({
      root: join(workDir, 'cache3'),
      key: videoCacheKey(videoPath, info.size, info.mtimeMs),
      videoPath,
      maxEdge: 512,
      requests: plan.frames,
      limitBytes: 64 * 1024 * 1024,
      tools: tools2,
    });
    expect(frames[0]!.bytes).toBeGreaterThan(0);
  });

  it('第二次取同样的帧命中缓存（不重跑 ffmpeg）', async () => {
    const videoPath = join(workDir, 'landscape.mp4');
    const info = await stat(videoPath);
    const key = videoCacheKey(videoPath, info.size, info.mtimeMs);
    const root = join(workDir, 'cache');
    const requests = [{ seconds: 1 }, { seconds: 3 }];

    const first = await ensureFrames({ root, key, videoPath, maxEdge: 512, requests, limitBytes: 64 * 1024 * 1024, tools: tools2 });
    const firstMtime = (await stat(first[0]!.path)).mtimeMs;
    expect(first).toHaveLength(2);
    expect(existsSync(first[1]!.path)).toBe(true);

    const second = await ensureFrames({ root, key, videoPath, maxEdge: 512, requests, limitBytes: 64 * 1024 * 1024, tools: tools2 });
    expect(second.map((frame) => frame.path)).toEqual(first.map((frame) => frame.path));
    // 复用同一个文件，说明这次没重新解码。
    expect((await stat(second[0]!.path)).mtimeMs).toBe(firstMtime);
  });

  it('换了缩略尺寸不会命中旧尺寸的帧', async () => {
    const videoPath = join(workDir, 'landscape.mp4');
    const info = await stat(videoPath);
    const key = videoCacheKey(videoPath, info.size, info.mtimeMs);
    const root = join(workDir, 'cache2');
    const requests = [{ seconds: 2 }];

    const small = await ensureFrames({ root, key, videoPath, maxEdge: 512, requests, limitBytes: 64 * 1024 * 1024, tools: tools2 });
    const large = await ensureFrames({ root, key, videoPath, maxEdge: 1024, requests, limitBytes: 64 * 1024 * 1024, tools: tools2 });
    expect(small[0]!.path).not.toBe(large[0]!.path);
  });
});

function makeVideo(path: string, size: string, duration: number, options: { audio: boolean }): void {
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${duration}:size=${size}:rate=30`];
  if (options.audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (options.audio) args.push('-c:a', 'aac', '-shortest');
  args.push(path, '-y');
  execFileSync(tools!.ffmpegPath, args, { timeout: 60_000 });
}
