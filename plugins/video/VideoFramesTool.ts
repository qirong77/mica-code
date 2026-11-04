import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MicaTool } from '@packages/mica-tools/index.js';
import type { ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import type { ToolResult } from '@packages/mica-tools/types.js';
import { truncateDisplayText } from '@packages/mica-tools/utils/display.js';
import { getPathOwnershipContext } from '@packages/mica-tools/utils/pathOwnership.js';
import { detectFfmpeg, probeVideo, scanFrameDiffs, type FfmpegTools, type VideoProbe } from './ffmpeg.js';
import {
  defaultCacheRoot,
  downloadSource,
  ensureFrames,
  expandHome,
  readScanCache,
  readFrameBase64,
  videoCacheKey,
  writeScanCache,
  type ExtractedFrame,
} from './frames.js';
import { planFrames, type FramePlan } from './plan.js';
import { detectSceneCuts, isStaticVideo, planFromCuts } from './scenes.js';
import { formatDuration, formatTimePoint, parseTimePoint } from './timestamps.js';

const MAX_SCALE = 1568;
const MIN_SCALE = 512;
/** 超过这个时长就不再整片解码找画面切换：解码是 O(时长) 的，长视频交给模型用 at 分段。 */
const SCENE_SCAN_MAX_SECONDS = 600;
/** 扫描时的取样帧率。2fps 对「画面停一会儿再切」的录屏足够，30s 视频只有 60 帧。 */
const SCENE_SCAN_FPS = 2;
const SCENE_SCAN_MAX_FRAMES = 600;

export type VideoFramesToolOptions = {
  /** 常驻会话里每次调用重新读设置，改了配置不必重开会话。 */
  getConfig: () => { ffmpegPath?: string; maxEdge: number; cacheLimitMb: number };
  /** 找不到 ffmpeg 时上报一次健康状态。 */
  onMissingFfmpeg: () => void;
};

export class VideoFramesTool extends MicaTool {
  private readonly getConfig: VideoFramesToolOptions['getConfig'];
  private readonly onMissingFfmpeg: VideoFramesToolOptions['onMissingFfmpeg'];
  private tools: FfmpegTools | null = null;
  private resolvedFor: string | undefined;

  constructor(options: VideoFramesToolOptions) {
    super(
      'video_frames',
      [
        '抽取视频的关键帧作为图片，用来理解视频内容。返回若干张图与它们各自的时间点。',
        '',
        '用法是两段式：先只传 source 抽 4 帧概览（同时拿到时长、分辨率、有无音轨），看清时间轴后，再用 at 精确点名要看的那几秒。',
        '',
        '时间点写法：4:50.5 表示 4 分 50.5 秒，1:02:03 表示 1 小时 2 分 3 秒，90 表示 90 秒。',
        '可寻址的单位是时间而不是帧序号——下一轮别再引用「第 3 帧」，直接引用返回文本里那个时间点。',
        '',
        '取帧有成本：每一帧都会作为图片进入上下文并在后续轮次重复发送。一次 3–6 帧通常就够，不要一次要满上限。',
        '只处理本地视频文件与 http/https 直链；音频内容不会被转写。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: '本地视频路径（绝对路径、相对当前工作目录、或以 ~/ 开头）或 http/https 直链',
          },
          at: {
            type: 'array',
            items: { type: 'string' },
            description:
              '精确点名要看的时刻，例如 ["4:50.5", "5:10"]。给了它就忽略 count。最多 8 个，超出会被截断。',
          },
          count: {
            type: 'number',
            description: '不传 at 时均匀抽几帧，默认 4，上限 12。',
          },
          start: { type: 'string', description: '均匀采样区间的起点，例如 "2:00"。不传就从开头。' },
          end: { type: 'string', description: '均匀采样区间的终点，例如 "3:30"。不传就采到结尾。' },
          scale: {
            type: 'number',
            description: `图片长边像素，默认取插件设置（1024），可用范围 ${MIN_SCALE}–${MAX_SCALE}。只有在看代码或小字时才需要调大。`,
          },
        },
        required: ['source'],
      },
      { readOnly: true },
    );
    this.getConfig = options.getConfig;
    this.onMissingFfmpeg = options.onMissingFfmpeg;
  }

  async execute(
    input: { source?: unknown; at?: unknown; count?: unknown; start?: unknown; end?: unknown; scale?: unknown },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<ToolResult> {
    const source = String(input.source ?? '').trim();
    if (!source) throw new Error('source 不能为空');

    const config = this.getConfig();
    const tools = await this.resolveTools(config.ffmpegPath);
    if (!tools) {
      this.onMissingFfmpeg();
      throw new Error(
        '没有找到 ffmpeg。请先安装（macOS: brew install ffmpeg），或在配置页 Plugins → Video 里填写 ffmpeg 的绝对路径。',
      );
    }

    const root = defaultCacheRoot();
    const loaded = await this.loadSource(source, root, callbacks);
    const probe = await probeVideo(tools.ffprobePath, loaded.path, callbacks?.signal);

    const at = normalizeStringList(input.at);
    const count = normalizeCount(input.count);
    // 给了但给错（0、负数、NaN）不能当成「没给」悄悄按默认值办：模型以为自己点名了
    // 张数，拿到的是几帧毫不相干的结果，还会照着这个错误前提继续跑。
    if (isPresent(input.count) && count === undefined) {
      throw new Error(`count 只接受正整数，收到 ${JSON.stringify(input.count)}。不传则默认 4 帧。`);
    }
    const start = normalizeString(input.start);
    const end = normalizeString(input.end);

    // 扫描范围与 planFrames 解析规则保持一致：没给就覆盖全片，给了就只扫那一段
    // （2 小时的录屏里看某 10 分钟，扫全片既慢又没用）。
    const range = resolveScanRange(probe.durationSeconds, start, end);
    const scenePlan = at
      ? null
      : await this.planBySceneChange({
          tools,
          videoPath: loaded.path,
          cacheRoot: root,
          cacheKey: loaded.key,
          durationSeconds: probe.durationSeconds,
          count: count ?? 4,
          rangeStartSeconds: range.start,
          rangeLengthSeconds: range.end - range.start,
          signal: callbacks?.signal,
        });

    const plan =
      scenePlan ??
      planFrames({
        durationSeconds: probe.durationSeconds,
        fps: probe.fps,
        at,
        count,
        start,
        end,
        defaultCount: 4,
      });

    const maxEdge = clampScale(normalizeScale(input.scale) ?? config.maxEdge);
    const frames = await ensureFrames({
      root,
      key: loaded.key,
      videoPath: loaded.path,
      maxEdge,
      requests: plan.frames,
      limitBytes: Math.max(64, config.cacheLimitMb) * 1024 * 1024,
      tools,
      signal: callbacks?.signal,
    });

    // 画面完全一样的帧只留一张。静止录屏、单页幻灯片、几秒没动的界面
    // 抽 4 帧就是同一张图发 4 遍，每张约 790 tokens 全喂给模型却没有任何新信息。
    // 判定用文件内容逐字节比较：同一个视频、同样的缩放参数下 ffmpeg 的输出是确定的，
    // 「完全一样」不会误判，而轻微变化的画面必然不同。
    const deduped = await dropIdenticalFrames(frames);
    // 静态视频那条说明已经讲过画面没变化，再补一条「这几帧相同」只是重复。
    const staticAlreadyExplained = plan.notes.some((note) => note.includes('静态画面'));
    const mergedNote =
      deduped.length < frames.length && !staticAlreadyExplained
        ? `${frames.length - deduped.length} 帧与相邻帧画面完全相同（静止画面），只保留一张`
        : null;
    const effectivePlan = mergedNote
      ? { frames: deduped.map((frame) => ({ seconds: frame.seconds })), notes: [...plan.notes, mergedNote] }
      : plan;

    const blocks: ToolResult = [
      {
        type: 'text',
        text: renderSummary({
          source,
          probe,
          plan: effectivePlan,
          frames: deduped.map((frame) => frame.seconds),
          maxEdge,
        }),
      },
    ];
    for (const frame of deduped) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: await readFrameBase64(frame) },
      });
    }
    return blocks;
  }

  /**
   * 没有点名时刻时，按「画面真的变了」来取样，而不是均匀撒点。
   *
   * 均匀取样会漏掉短片段：15 秒 4 段的录屏取 4 帧，可能三帧落在同一段里、另一段完全看不到。
   * 扫描失败（解码不了、超时、差异全为零）一律返回 null，退回均匀采样。
   */
  private async planBySceneChange(params: {
    tools: FfmpegTools;
    videoPath: string;
    cacheRoot: string;
    cacheKey: string;
    durationSeconds: number;
    count: number;
    rangeStartSeconds: number;
    rangeLengthSeconds: number;
    signal?: AbortSignal;
  }): Promise<FramePlan | null> {
    if (params.rangeLengthSeconds > SCENE_SCAN_MAX_SECONDS) return null;

    try {
      const scanKey = `${params.cacheKey}-${params.rangeStartSeconds.toFixed(1)}-${params.rangeLengthSeconds.toFixed(1)}`;
      const cached = await readScanCache(params.cacheRoot, scanKey);
      let diffs = cached;
      if (!diffs) {
        // 区间短就按 2fps 扫，区间长就降下来，保证整段都被覆盖而不是只扫开头一截。
        const fps = Math.max(0.5, Math.min(SCENE_SCAN_FPS, SCENE_SCAN_MAX_FRAMES / params.rangeLengthSeconds));
        const scanned = await scanFrameDiffs({
          ffmpegPath: params.tools.ffmpegPath,
          videoPath: params.videoPath,
          fps,
          maxFrames: SCENE_SCAN_MAX_FRAMES,
          startSeconds: params.rangeStartSeconds,
          lengthSeconds: params.rangeLengthSeconds,
          signal: params.signal,
        });
        diffs = scanned.diffs;
        await writeScanCache(params.cacheRoot, scanKey, diffs);
      }
      const fps = Math.max(0.5, Math.min(SCENE_SCAN_FPS, SCENE_SCAN_MAX_FRAMES / params.rangeLengthSeconds));
      const intervalSeconds = 1 / fps;
      const cuts = detectSceneCuts(diffs, intervalSeconds);
      // 整段没有变化就只给一帧：再多的帧都是同一张图，每张约 790 tokens。
      // 说明里要把这件事讲清楚，否则模型会以为「只抽到一帧是失败了」。
      if (isStaticVideo(diffs)) {
        // 取首尾各一帧而不是只取中间一帧：有些变化低于噪声底（整页只翻了个页码），
        // 画面差看不出但首尾一比就露出来了。真静止时多花一张图，认错成「只有一页」
        // 才是真代价。
        const base = params.rangeStartSeconds;
        const ceiling = Math.max(base, base + params.rangeLengthSeconds - 0.1);
        const head = Math.min(base + params.rangeLengthSeconds * 0.2, ceiling);
        const tail = Math.min(base + params.rangeLengthSeconds * 0.8, ceiling);
        const frames =
          params.count >= 2 && tail - head > 0.5
            ? [{ seconds: round3(head) }, { seconds: round3(tail) }]
            : [{ seconds: round3(Math.min(base + params.rangeLengthSeconds * 0.5, ceiling)) }];
        return {
          frames,
          notes: ['整段画面基本没有变化（静态画面），只给少量帧；要确认某处细节可用 at 精确点名'],
        };
      }
      const plan = planFromCuts(cuts, params.rangeLengthSeconds, Math.min(Math.max(1, Math.round(params.count)), 12));
      // 扫描抓到的时间点是相对区间起点的，换回视频里的绝对时间。
      return plan
        ? { ...plan, frames: plan.frames.map((frame) => ({ ...frame, seconds: round3(frame.seconds + params.rangeStartSeconds) })) }
        : null;
    } catch {
      return null;
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const at = normalizeStringList(input.at) ?? [];
    const requested = at.length > 0 ? at.slice(0, 3).join(', ') + (at.length > 3 ? ` +${at.length - 3}` : '') : '';
    const label = requested || `${normalizeCount(input.count) ?? 4} frames`;
    return `video ${truncateDisplayText(String(input.source ?? ''), 9)} · ${truncateDisplayText(label, 14)}`;
  }

  private async resolveTools(configuredPath: string | undefined): Promise<FfmpegTools | null> {
    const key = configuredPath?.trim() ?? '';
    if (this.tools && this.resolvedFor === key) return this.tools;
    this.tools = await detectFfmpeg(configuredPath);
    this.resolvedFor = key;
    return this.tools;
  }

  private async loadSource(
    source: string,
    root: string,
    callbacks?: ToolExecuteCallbacks,
  ): Promise<{ path: string; key: string }> {
    if (isHttpUrl(source)) return downloadSource(source, root, callbacks?.signal);

    const ownership = getPathOwnershipContext(callbacks?.context);
    const cwd = ownership?.cwd ?? process.cwd();
    const filePath = resolve(cwd, expandHome(source));
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new Error(`${filePath} 不是文件`);
    return { path: filePath, key: videoCacheKey(filePath, info.size, info.mtimeMs) };
  }
}

function renderSummary(params: {
  source: string;
  probe: VideoProbe;
  plan: FramePlan;
  frames: number[];
  maxEdge: number;
}): string {
  const { probe, plan, frames, maxEdge, source } = params;
  const facts = [
    `Duration: ${formatDuration(probe.durationSeconds)}`,
    probe.width && probe.height ? `${probe.width}x${probe.height}` : null,
    probe.fps ? `${probe.fps.toFixed(2)}fps` : null,
    probe.hasAudio ? 'audio: yes (not transcribed)' : 'audio: none',
    `long edge ≤ ${maxEdge}px`,
  ].filter(Boolean);

  const lines = [`Video: ${source}`, facts.join(' · '), `Frames (${frames.length}, images follow in this order):`];
  frames.forEach((seconds, index) => {
    lines.push(`  ${index + 1}. ${formatTimePoint(seconds)}`);
  });
  if (plan.notes.length > 0) lines.push(`Notes: ${plan.notes.join('；')}`);
  lines.push('引用某一帧时用上面那行时间点，不要用帧序号。');
  return lines.join('\n');
}

function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.map((entry) => String(entry ?? '').trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  const single = normalizeString(value);
  return single ? [single] : undefined;
}

function normalizeCount(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function round3(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** 采样区间，规则与 plan.ts 的 resolveRange 一致；这里只用于决定扫描范围。 */
function resolveScanRange(duration: number, start?: string, end?: string): { start: number; end: number } {
  const parsedStart = start ? parseTimePoint(start) : null;
  const parsedEnd = end ? parseTimePoint(end) : null;
  const lo = Math.max(0, Math.min(parsedStart ?? 0, duration));
  const hi = Math.max(lo, Math.min(parsedEnd ?? duration, duration));
  return { start: lo, end: hi };
}

/**
 * 丢掉与前面某一帧逐字节相同的帧，保留每个不同画面最早的时刻。
 *
 * 只做这一种判定：同样的视频与缩放参数下 ffmpeg 的输出是确定的，字节相同就是
 * 同一张图，绝不会把真变化合并掉。更激进的「看起来像不像」不能做——实测缩略图
 * 上静止画面的编码噪声比真实的微小变化还大。
 */
async function dropIdenticalFrames(frames: ExtractedFrame[]): Promise<ExtractedFrame[]> {
  if (frames.length < 2) return frames;
  const kept: ExtractedFrame[] = [];
  for (const frame of frames) {
    let duplicate = false;
    for (const earlier of kept) {
      if ((await readFrameBase64(frame)) === (await readFrameBase64(earlier))) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(frame);
  }
  return kept;
}

function normalizeScale(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clampScale(value: number): number {
  return Math.min(Math.max(Math.round(value), MIN_SCALE), MAX_SCALE);
}

/** 供插件启动时预热探测，避免第一次调用视频时要多等一次 `ffmpeg -version`。 */
export async function warmUpFfmpeg(path?: string): Promise<FfmpegTools | null> {
  return detectFfmpeg(path);
}
