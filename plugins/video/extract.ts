import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { probeVideo, scanFrameDiffs, type FfmpegTools, type VideoProbe } from './ffmpeg.js';
import {
  defaultCacheRoot,
  downloadSource,
  ensureFrames,
  expandHome,
  readFrameBase64,
  readScanCache,
  videoCacheKey,
  writeScanCache,
  type ExtractedFrame,
} from './frames.js';
import { planFrames, type FramePlan } from './plan.js';
import { detectSceneCuts, isStaticVideo, planFromCuts } from './scenes.js';
import { formatDuration, formatTimePoint, parseTimePoint } from './timestamps.js';

/**
 * 抽帧流水线：视频 → 采样计划 → 本地 JPEG。
 *
 * 这一层刻意不认识 `MicaTool` / `ToolResult`：同一条流水线要供两个入口使用，而两者
 * 交付结果的方式完全不同——会话工具把图片塞进 ToolResult（图片直接进上下文），
 * `/plugin/video/api` 只能回 JSON 化的本地路径（响应必须是可序列化的 JSON）。
 * 所以这里只负责「落盘 + 给路径 + 写一段说明」，谁去读那些图片由调用方决定。
 */

export const MIN_SCALE = 512;
export const MAX_SCALE = 1568;
/** 超过这个时长就不再整片解码找画面切换：解码是 O(时长) 的，长视频交给模型用 at 分段。 */
const SCENE_SCAN_MAX_SECONDS = 600;
/** 扫描时的取样帧率。2fps 对「画面停一会儿再切」的录屏足够，30s 视频只有 60 帧。 */
const SCENE_SCAN_FPS = 2;
const SCENE_SCAN_MAX_FRAMES = 600;

/** 场景取样的观察结果：固定 code，不带路径与异常文本。 */
export type ScenePlanObservation = { outcome: 'success' | 'partial' | 'skipped'; code: string };

export type FrameErrorCode =
  /** 参数本身不成立（source 为空、count 非法、时间点写法不对）。 */
  | 'invalid_request'
  /** 本地文件不存在 / 不是文件 / 远程下载失败。 */
  | 'source_unavailable'
  /** ffprobe、抽帧或写盘失败；message 是给调用方照着改的一句话。 */
  | 'extraction_failed';

/** 流水线的失败：调用方据此决定 HTTP 状态码，不用从 message 里猜。 */
export class FrameExtractionError extends Error {
  constructor(
    readonly code: FrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FrameExtractionError';
  }
}

export type FrameExtractionInput = {
  tools: FfmpegTools;
  /** 本地路径（绝对、相对 cwd、或 `~/` 开头）或 http/https 直链。 */
  source: string;
  /** 原始入参：类型校验与文案都在这里统一处理，调用方不必各写一遍。 */
  at?: unknown;
  count?: unknown;
  start?: unknown;
  end?: unknown;
  scale?: unknown;
  /** 插件设置：scale 未给时的长边与缓存上限。 */
  config: { maxEdge: number; cacheLimitMb: number };
  /** 相对路径的基准目录；接口拿不到会话 cwd，默认进程工作目录。 */
  cwd?: string;
  /** 缓存根目录，默认 `$MICA_HOME/plugin-data/video`；测试指向临时目录。 */
  cacheRoot?: string;
  signal?: AbortSignal;
  /** 场景取样是否成功；失败不改变结果，只用于观察。 */
  onScenePlan?: (result: ScenePlanObservation) => void;
};

export type ExtractedVideoFrame = {
  /** 帧在视频里的时刻（秒）。 */
  seconds: number;
  /** 格式化后的时间点（`4:50.5`）；模型引用某一帧时就用它。 */
  at: string;
  /** 可直接交给内置 `read_image` 的本地绝对路径。 */
  path: string;
  bytes: number;
};

export type FrameExtraction = {
  /** 写给人（模型）看的摘要：视频信息、帧路径列表、采样说明。 */
  text: string;
  frames: ExtractedVideoFrame[];
  probe: VideoProbe;
  /** 实际采用的采样计划（含夹取、去重说明）。 */
  plan: FramePlan;
};

/** 抽几帧、在哪些时刻抽——这部分的对外结果只有路径，图片本身不在这里读。 */
export async function extractFrames(input: FrameExtractionInput): Promise<FrameExtraction> {
  try {
    return await run(input);
  } catch (error) {
    throw normalizeFailure(error, input.signal);
  }
}

async function run(input: FrameExtractionInput): Promise<FrameExtraction> {
  const source = String(input.source ?? '').trim();
  if (!source) throw new FrameExtractionError('invalid_request', 'source 不能为空');
  input.signal?.throwIfAborted();

  const { tools, signal } = input;
  const root = input.cacheRoot ?? defaultCacheRoot();
  const loaded = await loadSource(source, root, input.cwd, signal);
  const probe = await probeVideo(tools.ffprobePath, loaded.path, signal);

  const at = normalizeStringList(input.at);
  const count = normalizeCount(input.count);
  // 给了但给错（0、负数、NaN）不能当成「没给」悄悄按默认值办：模型以为自己点名了
  // 张数，拿到的是几帧毫不相干的结果，还会照着这个错误前提继续跑。
  if (isPresent(input.count) && count === undefined) {
    throw new FrameExtractionError(
      'invalid_request',
      `count 只接受正整数，收到 ${JSON.stringify(input.count)}。不传则默认 4 帧。`,
    );
  }
  const start = normalizeString(input.start);
  const end = normalizeString(input.end);

  // 扫描范围与 planFrames 解析规则保持一致：没给就覆盖全片，给了就只扫那一段
  // （2 小时的录屏里看某 10 分钟，扫全片既慢又没用）。
  const range = resolveScanRange(probe.durationSeconds, start, end);
  const scenePlan = at
    ? null
    : await planBySceneChange({
        tools,
        videoPath: loaded.path,
        cacheRoot: root,
        cacheKey: loaded.key,
        durationSeconds: probe.durationSeconds,
        count: count ?? 4,
        rangeStartSeconds: range.start,
        rangeLengthSeconds: range.end - range.start,
        signal,
        onScenePlan: input.onScenePlan,
      });

  const plan =
    scenePlan ??
    uniformPlan({
      durationSeconds: probe.durationSeconds,
      fps: probe.fps,
      at,
      count,
      start,
      end,
      defaultCount: 4,
    });

  const maxEdge = clampScale(normalizeScale(input.scale) ?? input.config.maxEdge);
  const frames = await ensureFrames({
    root,
    key: loaded.key,
    videoPath: loaded.path,
    maxEdge,
    requests: plan.frames,
    limitBytes: Math.max(64, input.config.cacheLimitMb) * 1024 * 1024,
    tools,
    signal,
  });

  // 画面完全一样的帧只留一张。静止录屏、单页幻灯片、几秒没动的界面
  // 抽 4 帧就是同一张图落 4 份，模型逐张读还会把同一张图看 4 遍。
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

  return {
    text: renderSummary({ source, probe, plan: effectivePlan, frames: deduped, maxEdge }),
    frames: deduped.map(toVideoFrame),
    probe,
    plan: effectivePlan,
  };
}

export type ScenePlanInput = {
  tools: FfmpegTools;
  videoPath: string;
  cacheRoot: string;
  cacheKey: string;
  durationSeconds: number;
  count: number;
  rangeStartSeconds: number;
  rangeLengthSeconds: number;
  signal?: AbortSignal;
  onScenePlan?: (result: ScenePlanObservation) => void;
};

/**
 * 没有点名时刻时，按「画面真的变了」来取样，而不是均匀撒点。
 *
 * 均匀取样会漏掉短片段：15 秒 4 段的录屏取 4 帧，可能三帧落在同一段里、另一段完全看不到。
 * 扫描失败（解码不了、超时、差异全为零）一律返回 null，退回均匀采样。
 */
export async function planBySceneChange(params: ScenePlanInput): Promise<FramePlan | null> {
  const note = (outcome: ScenePlanObservation['outcome'], code: string) => {
    try {
      params.onScenePlan?.({ outcome, code });
    } catch {
      /* observation cannot change frame extraction */
    }
  };
  if (params.rangeLengthSeconds > SCENE_SCAN_MAX_SECONDS) {
    note('skipped', 'scan_range_limit');
    return null;
  }

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
    // 整段没有变化就只给一帧：再多的帧都是同一张图。
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
      note('success', 'static_scene');
      return {
        frames,
        notes: ['整段画面基本没有变化（静态画面），只给少量帧；要确认某处细节可用 at 精确点名'],
      };
    }
    const plan = planFromCuts(cuts, params.rangeLengthSeconds, Math.min(Math.max(1, Math.round(params.count)), 12));
    note(plan ? 'success' : 'skipped', plan ? 'scene_detected' : 'no_scene_plan');
    // 扫描抓到的时间点是相对区间起点的，换回视频里的绝对时间。
    return plan
      ? {
          ...plan,
          frames: plan.frames.map((frame) => ({ ...frame, seconds: round3(frame.seconds + params.rangeStartSeconds) })),
        }
      : null;
  } catch (error) {
    params.signal?.throwIfAborted();
    note('partial', error instanceof Error && error.name === 'TimeoutError' ? 'scene_timeout' : 'scene_scan_failed');
    return null;
  }
}

async function loadSource(
  source: string,
  root: string,
  cwd: string | undefined,
  signal?: AbortSignal,
): Promise<{ path: string; key: string }> {
  if (isHttpUrl(source)) {
    try {
      return await downloadSource(source, root, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new FrameExtractionError(
        'source_unavailable',
        `下载 ${source} 失败：${messageOf(error)}。长视频或远程视频请先下载到本地，再把本地路径传给 source。`,
      );
    }
  }

  const filePath = resolve(cwd ?? process.cwd(), expandHome(source));
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    throw new FrameExtractionError(
      'source_unavailable',
      `${filePath} 不是文件。传本地绝对路径或 ~/ 开头的路径；远程视频先下载到本地再传本地路径。`,
    );
  }
  return { path: filePath, key: videoCacheKey(filePath, info.size, info.mtimeMs) };
}

/** plan.ts 的报错都是「参数不成立」：时间点写法不对、区间反向、at 里一个时刻都没有。 */
function uniformPlan(input: Parameters<typeof planFrames>[0]): FramePlan {
  try {
    return planFrames(input);
  } catch (error) {
    throw new FrameExtractionError('invalid_request', messageOf(error));
  }
}

function toVideoFrame(frame: ExtractedFrame): ExtractedVideoFrame {
  return {
    seconds: frame.seconds,
    at: formatTimePoint(frame.seconds),
    path: frame.path,
    bytes: frame.bytes,
  };
}

/** 摘要交付的是路径，不是图片：调用方拿到之后要用内置 `read_image` 逐张看。 */
function renderSummary(params: {
  source: string;
  probe: VideoProbe;
  plan: FramePlan;
  frames: ExtractedFrame[];
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

  const lines = [`Video: ${source}`, facts.join(' · '), `Frames (${frames.length}) saved as local JPEG files:`];
  for (const frame of frames) lines.push(`  ${formatTimePoint(frame.seconds)}  ${frame.path}`);
  if (plan.notes.length > 0) lines.push(`Notes: ${plan.notes.join('；')}`);
  lines.push('这些图片没有进入上下文：用 read_image 逐张打开上面的路径（一次 3–6 张），看完再决定要不要用 at 点名。');
  lines.push('引用某一帧时用左边那个时间点，不要用序号或数组下标——下一轮谁都拿不到序号到时间的映射。');
  return lines.join('\n');
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

/** 取消与超时原样上抛：被吞掉的话，调用方会拿到一份「成功但为空」的结果。 */
function normalizeFailure(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason ?? new DOMException('抽帧已取消', 'AbortError');
  if (error instanceof FrameExtractionError) return error;
  if (isAbortLike(error)) return error;
  return new FrameExtractionError('extraction_failed', messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function isAbortLike(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
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

function normalizeScale(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clampScale(value: number): number {
  return Math.min(Math.max(Math.round(value), MIN_SCALE), MAX_SCALE);
}
