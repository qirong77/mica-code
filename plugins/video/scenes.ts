import type { FrameRequest } from './plan.js';

/**
 * 从「相邻帧差异」序列里找出画面真正发生变化的地方。
 *
 * 判据是局部极大 + 统计阈值：静止片段（差异恒为 0）里任何非零差异都是事件，
 * 而运动画面整体差异都很大时只有明显高于常态的才算切换。两条都不满足就返回空，
 * 调用方退回均匀采样。
 */

/** 低于这个差异一律当噪声：实测深色背景只有一行文字变化时约 0.004。 */
const DIFF_FLOOR = 0.0005;
/** 给末尾留一点余量，理由同 plan.ts 的末尾余量。 */
const END_SAFETY_MARGIN = 0.05;
/**
 * 切换点往后挪多久再取帧。
 *
 * 差异最大的那一刻正是转场本身：淡入淡出的中间态、幻灯片切换时的白场、窗口
 * 展开动画的半途。实测 4 步构建录屏取切换瞬间，第一帧是一整张纯白（亮度
 * 255）—— 既浪费一张图的 token，也会让模型以为「画面就是白的」。挪开几百毫秒
 * 落到新画面稳定之后才是这一段真正的样子。
 */
const CUT_SETTLE_SECONDS = 0.25;
/** 片头那一段短于这个长度就不单独取帧（只扫一小段区间时它常常几乎没有时长）。 */
const HEAD_SEGMENT_MIN_SECONDS = 1;

export type SceneCut = { seconds: number; score: number };

/**
 * 整段画面是否从头到尾没变过。
 *
 * 判据是全片帧差都低于噪声底：真的静止（一张截图录了 30 秒、幻灯片停在一页）。
 * 这种视频给 4 帧就是同一张图发 4 遍，每张约 790 tokens 却没有任何新信息。
 * 注意这不能用「压缩后图片像不像」来判断——实测缩略图的编码噪声（静止画面 53/4096
 * 格不同）反而比真实的微小变化（整页只改一个页码 2/4096 格）更大，那样判会把
 * 真变化当成噪声合并掉。
 */
export function isStaticVideo(diffs: number[]): boolean {
  if (diffs.length === 0) return false;
  return diffs.every((diff) => diff < DIFF_FLOOR);
}

/** 切换点 → 真正要取的时刻：后挪过转场，但不越过结尾。 */
function settled(cut: SceneCut, ceiling: number): number {
  return round(Math.min(cut.seconds + CUT_SETTLE_SECONDS, ceiling));
}

/**
 * 第一个切换点之前那一段单独取一帧，否则视频开头的内容永远看不到。
 *
 * 这一段太短时不取：「只扫 8–13 秒」这种区间常常一开始就是一次切换，段长不到
 * 一秒，再往它中点塞一帧就是紧贴切换点又一张几乎相同的图（实测差了 0.5 秒）。
 */
function pushHeadFrame(frames: FrameRequest[], firstCut: SceneCut, ceiling: number): void {
  if (firstCut.seconds < HEAD_SEGMENT_MIN_SECONDS) return;
  frames.push({ seconds: round(Math.min(firstCut.seconds / 2, ceiling)) });
}

export function detectSceneCuts(diffs: number[], intervalSeconds: number): SceneCut[] {
  if (diffs.length < 2 || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return [];

  const max = Math.max(...diffs);
  const sorted = [...diffs].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const mean = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const variance = diffs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / diffs.length;
  const steady = Math.max(DIFF_FLOOR, mean + 2 * Math.sqrt(variance));

  // 连续运动的画面（中位数本身就接近峰值）里，只有明显高于常态的才算切换。
  // 静止为主的画面（录屏、幻灯片）里绝大多数帧完全相同，中位数贴着 0，
  // 这时不能用一个剧烈切换把阈值一起抬高——同时存在的大变化和小变化都是真正的切换。
  // 静止为主的画面（录屏、幻灯片）里绝大多数帧完全相同，中位数贴着噪声基底。
  // 这时阈值必须只跟着噪声走：一条视频里只要有一次剧烈变化（切到另一个窗口、
  // 打开弹窗），按峰值折算的阈值就会抬到 0.1 以上，把同一视频里其他真实的小
  // 变化（一次转场只有 0.0006）全部吞掉——实测 4 步构建录屏只会报出 1 处变化。
  const mostlyStatic = median <= Math.max(max * 0.05, DIFF_FLOOR);
  const threshold = mostlyStatic ? Math.max(DIFF_FLOOR, median * 3) : steady;

  const cuts: SceneCut[] = [];
  for (let index = 0; index < diffs.length; index += 1) {
    const score = diffs[index]!;
    if (score < threshold) continue;
    // 只保留一段连续上升里的第一个峰，避免同一处变化报出两三个点。
    if (score < (diffs[index - 1] ?? 0) || score <= (diffs[index + 1] ?? 0)) continue;
    cuts.push({ seconds: (index + 1) * intervalSeconds, score });
  }
  return cuts;
}

/**
 * 把场景切换点变成要抽的时刻。
 *
 * 切换点本身是新场景的第一帧，所以每个切换点各取一帧；第一个切换点之前那段画面
 * 没有「变化」事件可依，单独取它的中点，否则视频开头的内容一定看不到。
 *
 * 切换点比要的帧数多时不能只挑变化最大的几个——录屏里每页的变化幅度和内容重要性
 * 毫无关系，只挑最大的会把所有帧挤到后半段、前面大半段完全看不到。这里改成按时间
 * 等分成 count 段，每段内部再挑变化最大的一处，保证时间轴上均匀覆盖。
 */
export function planFromCuts(
  cuts: SceneCut[],
  durationSeconds: number,
  count: number,
): { frames: FrameRequest[]; notes: string[] } | null {
  if (count < 1) return null;
  if (cuts.length === 0) return null;
  const ceiling = Math.max(0, durationSeconds - END_SAFETY_MARGIN);
  const usable = cuts.filter((cut) => cut.seconds > 0 && cut.seconds <= ceiling);
  if (usable.length === 0) return null;

  const notes: string[] = [];
  const ordered = [...usable].sort((left, right) => left.seconds - right.seconds);

  if (count === 1) {
    return { frames: [{ seconds: settled(ordered[0]!, ceiling) }], notes: ['按画面变化取样，只取了第一个切换点'] };
  }

  // 场景段数 = 切换点数 + 1（第一个切换点之前那段自成一段）。
  const segmentCount = ordered.length + 1;
  const frames: FrameRequest[] = [];

  if (segmentCount <= count) {
    pushHeadFrame(frames, ordered[0]!, ceiling);
    for (const cut of ordered) frames.push({ seconds: settled(cut, ceiling) });
    // 段数比请求的帧数少时到此为止，不再补齐。段边界就是内容边界，每段一帧
    // 已经把不同画面全拿到了；再往里塞只能塞进某一段内部，而一段内部没有切换点
    // 就意味着画面没变（实测 3 页幻灯片要 4 帧，第 4 张只能是某一页的重复）。
    // 硬凑到 count 只会多花几百 token 换一张一样的图。
    if (frames.length < count) {
      notes.push(`画面只有 ${segmentCount} 段，每段给一帧（少于请求的 ${count} 帧，再多只会重复）`);
    }
    return { frames: frames.sort((left, right) => left.seconds - right.seconds), notes };
  } else {
    for (let bucket = 0; bucket < count; bucket += 1) {
      const from = Math.floor((bucket * segmentCount) / count);
      const to = Math.floor(((bucket + 1) * segmentCount) / count);
      // 第 i 段（i >= 1）从 ordered[i-1] 开始；第 0 段是片头到第一个切换点。
      const candidates: SceneCut[] = [];
      for (let segment = from; segment < to && segment >= 1; segment += 1) {
        const cut = ordered[segment - 1];
        if (cut) candidates.push(cut);
      }
      if (candidates.length === 0) {
        pushHeadFrame(frames, ordered[0]!, ceiling);
        continue;
      }
      // 幅度接近时取靠后的那个：每一段要代表的是「这一段持续到什么时候」，
      // 取最早的会把整条视频的取样整体往前挤，末尾一大段没人看。
      const best = candidates.reduce((left, right) => (right.score >= left.score ? right : left));
      frames.push({ seconds: settled(best, ceiling) });
    }
    notes.push(`画面变化 ${ordered.length} 处，按时间等分成 ${count} 段、每段取变化最明显的一帧`);
  }

  // 变化点之外还有余量就用均匀取样补齐，别让一次调用比请求的少给图。
  if (frames.length < count) {
    notes.push('画面变化不足，其余按均匀取样补齐');
    const step = durationSeconds / count;
    // 补进来的帧要和已有帧拉得开，否则会紧贴着一个切换点再取一张
    // 几乎一样的图（实测 6.3 与 6.4 两帧只差 0.1 秒）。间隔按这一段应有的
    // 疏密折算，长视频给得宽、短视频给得窄。
    const minGap = Math.max(0.5, step * 0.3);
    for (let index = 0; frames.length < count && index < count * 2; index += 1) {
      const candidate = round(Math.min(step * (index + 0.5), ceiling));
      if (frames.every((frame) => Math.abs(frame.seconds - candidate) >= minGap)) frames.push({ seconds: candidate });
    }
  }

  return { frames: frames.sort((left, right) => left.seconds - right.seconds), notes };
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
