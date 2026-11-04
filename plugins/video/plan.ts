import { formatTimePoint, parseTimePoint } from './timestamps.js';

/**
 * 决定「这次调用到底要取哪几个时刻」。
 *
 * 这是纯逻辑：给定时长与模型的参数，吐出时刻列表与要写进结果文本的说明（哪个时刻被夹到
 * 时长内、哪几个被超上限截掉）。抽帧与缓存交给 ffmpeg 那一层，所以规则可以脱离 ffmpeg 测。
 */

/** 一次调用最多返回几张图。再多就是拿 token 换不了多少信息。 */
export const MAX_FRAMES = 12;
/** 模型点名指定时刻时更严：点名通常意味着它要精确看某几秒，而不是扫一遍。 */
export const MAX_EXPLICIT_FRAMES = 8;
/** 两个时刻相差不到这个值就是同一帧，合并掉——省一次解码，也省一张图的 token。 */
const SAME_FRAME_EPSILON = 0.05;
/**
 * 采样上界给时长留的余量（秒）。
 *
 * `-ss` 落在最后一帧之后时 ffmpeg 一个包都取不到，输出空文件并以失败退出。余量必须大于
 * 一个帧间隔，否则「夹到结尾」仍然取不到画面——15 秒 10fps 的视频末尾是 14.9 帧，
 * 退 0.05 秒落在 14.95，还是空的。
 */
const END_SAFETY_MARGIN_SECONDS = 0.1;
/**
 * 短于这个长度的区间不做居中取样：整段也就几帧，取第一帧之外的位置在
 * seek 之后已经没有帧了（单帧视频的帧一直在 t=0）。
 */
const MIN_SAMPLABLE_SPAN_SECONDS = 0.2;

export type FrameRequest = {
  /** 模型写的原值，夹取后要能说明「你要 X，给的是 Y」。 */
  requested?: string;
  seconds: number;
};

type ParsedEntry = { text: string; seconds: number; clampedFrom?: number };

export type FramePlan = {
  frames: FrameRequest[];
  /** 写进工具结果的补充说明；空数组表示没什么可解释的。 */
  notes: string[];
};

export type PlanInput = {
  durationSeconds: number;
  /** 帧率，用来算末尾余量；缺省按 25fps 估。 */
  fps?: number | null;
  at?: string[];
  count?: number;
  start?: string;
  end?: string;
  defaultCount: number;
};

export function planFrames(input: PlanInput): FramePlan {
  const { durationSeconds } = input;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('这段视频读不出有效时长，无法定位帧');
  }

  const upperBound = roundTo(durationSeconds, 3);
  const at = (input.at ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  if (at.length > 0) {
    return planExplicit(at, upperBound, endMarginSeconds(input.fps), input.count, input.start, input.end);
  }

  return planUniform(input, upperBound);
}

function planExplicit(
  at: string[],
  durationSeconds: number,
  marginSeconds: number,
  count: number | undefined,
  start: string | undefined,
  end: string | undefined,
): FramePlan {
  const notes: string[] = [];
  const parsed: ParsedEntry[] = [];
  const invalid: string[] = [];

  // 只有点名到确切时刻时才可能正好落在时长上；均匀采样是居中取样，碰不到端点。
  // 极短视频（单帧导出、只有一两帧的动图）整段时长还不到余量，退余量会退回 0 秒之后，
  // 而 seek 到那里已经越过唯一那一帧、一帧都取不到。这种长度直接取 0 秒——内容本来就在开头。
  const latest =
    durationSeconds > marginSeconds * 3 ? durationSeconds - marginSeconds : 0;

  for (const entry of at) {
    const seconds = parseTimePoint(entry);
    if (seconds === null) {
      invalid.push(entry);
      continue;
    }
    const clamped = Math.min(seconds, latest);
    parsed.push({ text: entry, seconds: clamped, clampedFrom: clamped < seconds ? seconds : undefined });
  }

  if (invalid.length > 0) {
    throw new Error(
      `无法解析的时间点：${invalid.join('、')}。请用 3:20.5（分:秒）或 1:02:03（时:分:秒）这样的写法。`,
    );
  }
  if (parsed.length === 0) throw new Error('at 里没有任何时间点');

  const deduped: ParsedEntry[] = [];
  for (const frame of parsed) {
    if (!deduped.some((kept) => Math.abs(kept.seconds - frame.seconds) <= SAME_FRAME_EPSILON)) deduped.push(frame);
  }
  if (deduped.length < parsed.length) {
    notes.push(`${parsed.length - deduped.length} 个时间点与相邻时刻重合，已合并`);
  }

  // 夹取说明要在合并之前算：两个都很远的时刻会被合并成一张图，
  // 只报第一个等于让模型以为第二个被忽略了。
  const clampedEntries = parsed.filter((frame) => frame.clampedFrom !== undefined);
  if (clampedEntries.length > 0) {
    notes.push(
      `以下时刻超出视频时长，已夹到结尾：${clampedEntries
        .map((frame) => `${frame.text} → ${formatTimePoint(frame.seconds)}`)
        .join('、')}`,
    );
  }

  const kept = deduped.slice(0, MAX_EXPLICIT_FRAMES);
  if (deduped.length > kept.length) {
    notes.push(`一次最多取 ${MAX_EXPLICIT_FRAMES} 个指定时刻，已按顺序取前 ${MAX_EXPLICIT_FRAMES} 个`);
  }

  if (typeof count === 'number' && Number.isFinite(count)) {
    notes.push('给了 at 时 count 不生效');
  }
  if ((start || end) && at.length > 0) {
    notes.push('给了 at 时 start/end 不生效');
  }

  return {
    frames: kept
      .sort((a, b) => a.seconds - b.seconds)
      .map((frame) => (frame.clampedFrom === undefined ? { seconds: frame.seconds } : { requested: frame.text, seconds: frame.seconds })),
    notes,
  };
}

function planUniform(input: PlanInput, durationSeconds: number): FramePlan {
  const notes: string[] = [];
  const range = resolveRange(input, durationSeconds, notes);
  const count = resolveCount(input.count, input.defaultCount, notes);

  // 极短视频（单帧导出、几帧的动图）整段还不到一个采样步长，居中取样会落在
  // 唯一那一帧之后：seek 过了它就是一帧也取不到。这种长度只取开头一帧。
  if (range.end - range.start <= MIN_SAMPLABLE_SPAN_SECONDS) {
    notes.push(`视频只有 ${range.end - range.start} 秒，只取开头一帧`);
    return { frames: [{ seconds: roundTo(range.start, 3) }], notes };
  }

  // 居中取样而不是取两端：首帧常是黑场或 logo，最后一帧可能因为关键帧对齐取不到。
  const step = (range.end - range.start) / count;
  const frames: FrameRequest[] = [];
  for (let index = 0; index < count; index += 1) {
    frames.push({ seconds: roundTo(range.start + step * (index + 0.5), 3) });
  }

  const deduped = frames.filter(
    (frame, index) => index === 0 || frame.seconds - frames[index - 1]!.seconds > SAME_FRAME_EPSILON,
  );
  if (deduped.length < frames.length) {
    notes.push('区间太短，部分时刻重合已合并');
  }

  return { frames: deduped, notes };
}

function resolveRange(input: PlanInput, durationSeconds: number, notes: string[]): { start: number; end: number } {
  let start = 0;
  let end = durationSeconds;

  if (input.start?.trim()) {
    const parsed = parseTimePoint(input.start);
    if (parsed === null) throw new Error(`无法解析 start：${input.start}。请用 3:20.5 这样的写法。`);
    start = Math.min(parsed, durationSeconds);
    if (parsed > durationSeconds) notes.push('start 超出视频时长，已夹到结尾');
  }
  if (input.end?.trim()) {
    const parsed = parseTimePoint(input.end);
    if (parsed === null) throw new Error(`无法解析 end：${input.end}。请用 3:20.5 这样的写法。`);
    end = Math.min(parsed, durationSeconds);
    if (parsed > durationSeconds) notes.push('end 超出视频时长，已夹到结尾');
  }

  if (end <= start) throw new Error(`区间无效：start ${formatTimePoint(start)} 不早于 end ${formatTimePoint(end)}`);
  return { start, end };
}

function resolveCount(count: number | undefined, defaultCount: number, notes: string[]): number {
  const raw = typeof count === 'number' && Number.isFinite(count) ? count : defaultCount;
  const rounded = Math.round(raw);
  const clamped = Math.min(Math.max(1, rounded), MAX_FRAMES);
  if (rounded !== clamped) {
    notes.push(`count ${raw} 超出一张图表的成本上限，按 ${clamped} 张取`);
  }
  return clamped;
}

/** 末尾余量至少两帧：一帧用来避开「最后一帧之后」，另一帧吃掉 seek 的取整误差。 */
function endMarginSeconds(fps: number | null | undefined): number {
  const safeFps = typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? Math.min(fps, 120) : 25;
  return Math.max(END_SAFETY_MARGIN_SECONDS, 2 / safeFps);
}

function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}
