import { describe, expect, it } from 'vitest';
import { detectSceneCuts, isStaticVideo, planFromCuts } from './scenes.js';

/** 静止 8 帧 → 变化 → 静止 8 帧，重现「录屏里画面停一会儿再切」。 */
function staticThenCut(before: number, after: number, score: number): number[] {
  return [...Array<number>(before).fill(0), score, ...Array<number>(after).fill(0)];
}

describe('detectSceneCuts', () => {
  it('在完全静止的片段里只把非零差异当切换点', () => {
    const diffs = staticThenCut(4, 4, 0.008);
    const cuts = detectSceneCuts(diffs, 0.5);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.seconds).toBe(2.5);
  });

  it('识别多处切换并各自只报一个点', () => {
    const diffs = [0, 0, 0.006, 0, 0, 0.009, 0, 0, 0.004, 0, 0];
    const cuts = detectSceneCuts(diffs, 0.5);
    expect(cuts.map((cut) => cut.seconds)).toEqual([1.5, 3, 4.5]);
  });

  it('连续上升的峰只保留最高的那个', () => {
    const diffs = [0, 0, 0, 0, 0.002, 0.005, 0.008, 0.004, 0, 0, 0, 0];
    const cuts = detectSceneCuts(diffs, 0.5);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.seconds).toBe(3.5);
  });

  it('整体都在运动的视频里不把常态差异当成切换', () => {
    const diffs = Array.from({ length: 40 }, (_, index) => 0.01 + (index % 3) * 0.0005);
    expect(detectSceneCuts(diffs, 0.5)).toEqual([]);
  });

  it('画面一直不动时没有切换点', () => {
    expect(detectSceneCuts(Array<number>(30).fill(0), 0.5)).toEqual([]);
  });

  it('太短的差异序列不参与判定', () => {
    expect(detectSceneCuts([0], 0.5)).toEqual([]);
    expect(detectSceneCuts([0, 0.9], 0)).toEqual([]);
  });
});

describe('planFromCuts', () => {
  const cuts = [
    { seconds: 3, score: 0.0065 },
    { seconds: 6, score: 0.0078 },
    { seconds: 9, score: 0.0043 },
  ];

  it('每段各取一帧，开头那段取中点', () => {
    const plan = planFromCuts(cuts, 15, 4)!;
    expect(plan.frames.map((frame) => frame.seconds)).toEqual([1.5, 3.25, 6.25, 9.25]);
  });

  it('切换点比要的帧数多时按时间等分，不把帧全挤在一段里', () => {
    const many = [3, 6, 9, 12].map((seconds, index) => ({ seconds, score: 0.001 * (index + 1) }));
    const plan = planFromCuts(many, 15, 3)!;
    // 五段（片头 + 四个切换点）分三桶：桶 0 只有片头，桶 1 取 3/6 里变化大的，桶 2 取 9/12 里变化大的。
    expect(plan.frames.map((frame) => frame.seconds)).toEqual([1.5, 6.25, 12.25]);
    expect(plan.notes.join()).toContain('按时间等分成 3 段');
  });

  it('变化幅度和位置无关时不漏掉前半段', () => {
    // 变化最剧烈的几处都在后半段，前半段也必须至少各有一帧。
    const cuts = [10, 20, 30, 40, 50].map((seconds) => ({
      seconds,
      score: seconds >= 40 ? 0.05 : 0.001,
    }));
    const frames = planFromCuts(cuts, 60, 4)!.frames.map((frame) => frame.seconds);
    expect(frames[0]).toBeLessThan(15);
    expect(frames[1]).toBeLessThan(30);
    expect(frames[3]).toBeGreaterThan(45);
  });

  it('段数比请求的帧数少时如实给段数，不硬凑重复帧', () => {
    // 只有 1 处切换 = 2 段，请求 4 帧也只能给出 2 个不同画面；
    // 再凑两帧必然落在某一段内部，而段内没有切换点就意味着画面没变。
    const plan = planFromCuts([{ seconds: 5, score: 0.01 }], 20, 4)!;
    expect(plan.frames).toHaveLength(2);
    expect(plan.notes.join()).toContain('只有 2 段');
  });

  it('切换点落在结尾之外时丢掉，避免取不到画面', () => {
    const plan = planFromCuts([{ seconds: 14.99, score: 0.01 }], 15, 2);
    expect(plan).toBeNull();
  });

  it('只有一个切换点且只要一帧时取它本身', () => {
    expect(planFromCuts(cuts, 15, 1)!.frames).toEqual([{ seconds: 3.25 }]);
  });

  it('没有切换点时不接管采样，交给均匀取样', () => {
    expect(planFromCuts([], 15, 4)).toBeNull();
  });
});

describe('实测发现的回归', () => {
  it('同一条视频里一次剧变不会把其他真实切换吞掉', () => {
    // 实测 4 步构建录屏：窗口切换那一次差异 0.89，其余三次转场只有 0.0006。
    // 按峰值折算的阈值会把小的三次全滤掉，整条视频只报出 1 处变化。
    const diffs = new Array(34).fill(0);
    diffs[7] = 0.00063; // 4.0s
    diffs[15] = 0.8921; // 8.0s
    diffs[16] = 0.89235; // 8.5s
    diffs[24] = 0.00082; // 12.5s
    const cuts = detectSceneCuts(diffs, 0.5);
    const seconds = cuts.map((cut) => cut.seconds);
    expect(seconds).toContain(4);
    expect(seconds).toContain(12.5);
    expect(seconds.length).toBeGreaterThanOrEqual(3);
  });

  it('切换点往后挪一点，取的不是转场中间的空白帧', () => {
    // 实测取切换瞬间那一帧是一整张纯白（转场白场），对理解内容毫无价值。
    const cuts = [{ seconds: 4, score: 0.9 }];
    const plan = planFromCuts(cuts, 17, 2)!;
    // frames[0] 是片头那段的中点，frames[1] 才是切换点派生出来的那一帧。
    expect(plan.frames[0]!.seconds).toBe(2);
    const afterCut = plan.frames[1]!.seconds;
    expect(afterCut).toBeGreaterThan(4);
    expect(afterCut).toBeLessThan(4.6);
  });

  it('补齐的帧不会紧贴着一个切换点再取一张几乎一样的图', () => {
    const cuts = [{ seconds: 6, score: 0.002 }];
    const frames = planFromCuts(cuts, 18, 4)!.frames.map((frame) => frame.seconds);
    for (let index = 1; index < frames.length; index += 1) {
      expect(frames[index]! - frames[index - 1]!).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('静态视频识别', () => {
  it('全片都在噪声底以下才算静态', () => {
    expect(isStaticVideo([0, 0, 0.00001])).toBe(true);
    expect(isStaticVideo([0, 0, 0.001])).toBe(false);
    expect(isStaticVideo([])).toBe(false);
  });

  it('真实静止录屏的差异序列被判为静态', () => {
    // 30 秒静止画面实测只有一处 0.00006 的编码抖动。
    const diffs = new Array(59).fill(0);
    diffs[49] = 0.00006;
    expect(isStaticVideo(diffs)).toBe(true);
  });
});
