import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * ffmpeg / ffprobe 的调用层。
 *
 * 只做三件事：找到可执行文件、读视频元信息、按时刻抽一帧。采样计划在 `plan.ts`，
 * 缓存与落盘在 `frames.ts`——这里保持无状态，方便单测用假的二进制替换。
 */

const PROBE_TIMEOUT_MS = 20_000;
const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * GUI 启动的应用拿到的 PATH 常常只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
 * Homebrew 装在 `/opt/homebrew/bin` 下的 ffmpeg 因此找不到。这几个目录按平台补上，
 * 用户仍然可以在插件设置里直接写绝对路径。
 */
const WELL_KNOWN_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/snap/bin',
  '/usr/local/sbin',
];

export type FfmpegTools = {
  ffmpegPath: string;
  ffprobePath: string;
  version: string;
};

export type VideoProbe = {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number | null;
  videoCodec: string | null;
  hasAudio: boolean;
  container: string | null;
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
};

type FfprobeOutput = {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string };
};

/** 返回 null 表示这台机器上不可用——调用方负责上报健康状态。 */
export async function detectFfmpeg(configuredPath?: string): Promise<FfmpegTools | null> {
  const ffmpegPath = resolveExecutable('ffmpeg', configuredPath?.trim() || undefined);
  if (!ffmpegPath) return null;
  const ffprobePath = resolveExecutable('ffprobe', siblingProbe(configuredPath?.trim() || undefined, ffmpegPath));
  if (!ffprobePath) return null;

  try {
    const { stdout } = await run(ffmpegPath, ['-version'], { timeoutMs: 10_000 });
    // 首行是 `ffmpeg version 8.1.1 Copyright (c) ...`，取版本号本身，别把版权行一起塞进状态栏。
    const version = /version\s+(\S+)/i.exec(stdout.split('\n')[0] ?? '')?.[1] ?? '';
    return { ffmpegPath, ffprobePath, version };
  } catch {
    return null;
  }
}

/** 用户在设置里写的是 ffmpeg 的路径时，ffprobe 通常就在隔壁。 */
function siblingProbe(configured: string | undefined, ffmpegPath: string): string | undefined {
  if (configured) return configured.replace(/ffmpeg(\.exe)?$/i, (match) => match.replace(/ffmpeg/i, 'ffprobe'));
  if (isAbsolute(ffmpegPath)) return join(ffmpegPath.replace(/[^/\\]+$/, ''), 'ffprobe');
  return undefined;
}

function resolveExecutable(name: string, configured?: string): string | null {
  if (configured && isAbsolute(configured)) return isExecutable(configured) ? configured : null;

  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name))
    .find(isExecutable);
  if (fromPath) return fromPath;

  return WELL_KNOWN_BIN_DIRS.map((dir) => join(dir, name)).find(isExecutable) ?? null;
}

function isExecutable(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function probeVideo(ffprobePath: string, filePath: string, signal?: AbortSignal): Promise<VideoProbe> {
  const { stdout } = await run(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: PROBE_TIMEOUT_MS, signal },
  ).catch((error: unknown) => {
    // ffprobe 失败时原始信息是「Command failed: /opt/homebrew/bin/ffprobe -v error …」
    // 加几行容器解析报错。这些是给排查用的，模型拿到只会照抄一遍。
    throw new Error(describeProbeFailure(String((error as Error)?.message ?? error), filePath));
  });

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new Error('ffprobe 返回的内容不是有效 JSON');
  }

  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('这个文件里没有视频流（可能是纯音频或图片）');
  const hasAudio = (parsed.streams ?? []).some((stream) => stream.codec_type === 'audio');

  const durationSeconds = toNumber(parsed.format?.duration) ?? toNumber(video.duration);
  if (durationSeconds === undefined || durationSeconds <= 0) throw new Error('读不出视频时长');

  return {
    durationSeconds,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate),
    videoCodec: video.codec_name ?? null,
    hasAudio,
    container: parsed.format?.format_name ?? null,
  };
}

/** 把 ffprobe 的底层报错翻成一句能直接看的话。 */
function describeProbeFailure(raw: string, filePath: string): string {
  const name = filePath.replace(/^.*[\\/]/, '');
  if (/moov atom not found|Invalid data found|End of file|partial file|could not find codec/i.test(raw)) {
    return `无法解析 ${name}：文件看起来不完整或已损坏`;
  }
  if (/No such file or directory/i.test(raw)) return `${filePath} 读不到（文件不存在或没有权限）`;
  if (/Permission denied/i.test(raw)) return `${filePath} 没有读取权限`;
  const firstLine = raw.split('\n').map((line) => line.trim()).filter((line) => line && !/^Command failed:/.test(line))[0];
  return firstLine ? `无法解析 ${name}：${firstLine.slice(0, 200)}` : `无法解析 ${name}`;
}

/**
 * 抽一帧出来写成 JPEG 文件。
 *
 * `-ss` 放在 `-i` 之前：ffmpeg 会从最近的关键帧开始解码，长视频里这是数量级的差别；
 * 转码模式下默认 `accurate_seek`，落点误差在毫秒级，理解视频用不上更精确。
 * 缩放必须在这一步做完——`prepareImageForApi` 只重编码 PNG，ffmpeg 抽出来的 JPEG
 * 帧会原样上行（`mica-common/image.ts`），原尺寸的一帧 4K 图进 API 就是几十倍体积。
 */
export async function extractFrame(options: {
  ffmpegPath: string;
  videoPath: string;
  seconds: number;
  maxEdge: number;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { ffmpegPath, videoPath, seconds, maxEdge, outputPath, signal } = options;
  const noFrameMessage = `在 ${seconds.toFixed(2)} 秒处取不到画面（超出可解码范围或视频结尾）`;
  const seekArgs = ['-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, seconds).toFixed(3), '-i', videoPath];
  const jpegArgs = [
    '-frames:v',
    '1',
    '-vf',
    `scale=w=min(${maxEdge}\\,iw):h=min(${maxEdge}\\,ih):force_original_aspect_ratio=decrease`,
    '-q:v',
    '3',
    '-y',
    outputPath,
  ];
  try {
    await run(ffmpegPath, [...seekArgs, ...jpegArgs], { timeoutMs: EXTRACT_TIMEOUT_MS, signal });
  } catch (error) {
    // 这个位置没有画面时 ffmpeg 报的是「没有 packet 被写入」这类实现细节，换成人话。
    const message = error instanceof Error ? error.message : String(error);
    if (/received no packets|Nothing was written/i.test(message)) throw new Error(noFrameMessage);
    throw error;
  }

  // 也可能以 0 退出却什么都没写。
  const size = existsSync(outputPath) ? await stat(outputPath).then((info) => info.size).catch(() => 0) : 0;
  if (size === 0) throw new Error(noFrameMessage);
}

/**
 * 把整段视频降采样成一串极小的灰度帧并算出相邻帧差异。
 *
 * 为什么不用 ffmpeg 的 `scene` 分值：它是全画面直方图差异，深色背景的录屏里
 * 文字变了也只影响很小一块面积，实测切换点只有 0.02，远低于常用的 0.2 阈值，
 * 而录屏恰恰是最主要的用例。降采样到 96x54 自己算均值绝对差，信号干净得多。
 *
 * 只扫短视频：解码全片是 O(时长) 的开销，长视频交给模型分段用 `at` 指定。
 */
export async function scanFrameDiffs(options: {
  ffmpegPath: string;
  videoPath: string;
  fps: number;
  maxFrames: number;
  /** 只扫描这一段（秒）；省略则扫全片。返回的差异序列相对于这一段的起点。 */
  startSeconds?: number;
  lengthSeconds?: number;
  signal?: AbortSignal;
}): Promise<{ intervalSeconds: number; diffs: number[] }> {
  const { ffmpegPath, videoPath, fps, maxFrames, startSeconds, lengthSeconds, signal } = options;
  const width = 96;
  const height = 54;
  const frameBytes = width * height;
  const intervalSeconds = 1 / fps;
  const rangeArgs: string[] = [];
  if (startSeconds !== undefined && startSeconds > 0) rangeArgs.push('-ss', startSeconds.toFixed(3));
  if (lengthSeconds !== undefined) rangeArgs.push('-t', lengthSeconds.toFixed(3));

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...rangeArgs,
        '-i',
        videoPath,
        '-vf',
        `fps=${fps},scale=${width}:${height},format=gray`,
        '-f',
        'rawvideo',
        '-',
      ],
      { signal },
    );

    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (bytes <= maxFrames * frameBytes) {
        chunks.push(chunk);
        bytes += chunk.length;
      }
    });
    child.on('error', (error) => finish(error));
    // 退出码要带上：解不出来时 stdout 是空的或只有前几帧，按成功返回会让调用方把
    // 「扫不动」当成「画面没变化」，还会把这份半截结果写进缓存。
    child.on('close', (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`ffmpeg 扫描画面差异失败（退出码 ${code}）：${errors.join('').trim().slice(-400)}`));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // 差异扫描失败不该让整次调用失败，调用方会退回均匀采样；错误文本只用来解释原因。
      if (errors.length < 16) errors.push(chunk);
    });
  });

  const frameCount = Math.floor(buffer.length / frameBytes);
  const diffs: number[] = [];
  for (let index = 1; index < frameCount; index += 1) {
    let sum = 0;
    const current = index * frameBytes;
    const previous = (index - 1) * frameBytes;
    for (let offset = 0; offset < frameBytes; offset += 1) {
      sum += Math.abs(buffer[current + offset]! - buffer[previous + offset]!);
    }
    diffs.push(sum / frameBytes / 255);
  }
  return { intervalSeconds, diffs };
}

function run(
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: options.timeoutMs, signal: options.signal, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').trim().split('\n').slice(-4).join(' ').slice(0, 400);
          reject(new Error(detail ? `${error.message}：${detail}` : error.message));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const [numerator, denominator] = raw.split('/').map(Number);
  if (!Number.isFinite(numerator) || numerator <= 0) return null;
  if (!Number.isFinite(denominator) || denominator === 0) return numerator;
  const value = numerator / denominator;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function toNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
