import { describe, expect, it } from 'vitest';
import { estimateContextTokens, estimateTextTokens, resolveRequestOverhead } from './tokenEstimate.js';

describe('local token estimation', () => {
  it('handles empty, ASCII and CJK without serializing the history', () => {
    expect(estimateTextTokens('')).toBe(0);
    // 每类字符的折算都用 10 万字符的真实语料标定过（词与空白 0.255、中文 0.65 token/字）。
    expect(estimateTextTokens('a '.repeat(2000))).toBe(1020);
    expect(estimateTextTokens('中文对话'.repeat(1000))).toBe(2600);
    const payload = { role: 'tool', content: 'value'.repeat(100_000), toJSON() { throw new Error('must not serialize'); } };
    expect(estimateContextTokens([payload])).toBeGreaterThan(100_000);
  });

  // 分词器对中文按字切、对不带分隔符的 base64/哈希切得更碎。旧口径「ASCII 四字符一
  // token、CJK 每字 1.5 token」实测把中文高估 2.3 倍、把 base64 低估 2.8 倍。
  it('weights CJK and unbroken payloads by measurement, not by a single ASCII ratio', () => {
    const chinese = estimateTextTokens('我们的会话压缩把工具结果换成占位符'.repeat(100));
    expect(chinese / ('我们的会话压缩把工具结果换成占位符'.length * 100)).toBeGreaterThan(0.5);
    expect(chinese / ('我们的会话压缩把工具结果换成占位符'.length * 100)).toBeLessThan(0.85);
    const payload = 'iVBORw0KGgoAAAANSUhEUg'.repeat(2000);
    const base64 = estimateTextTokens(payload);
    expect(base64 / payload.length).toBeGreaterThan(0.6);
    expect(base64 / payload.length).toBeLessThan(0.8);
  });

  it('grows with nested text, handles cycles defensively, and does not change inputs', () => {
    const small = [{ type: 'function_call', arguments: JSON.stringify({ content: 'small' }) }];
    const big = [{ type: 'function_call', arguments: JSON.stringify({ content: 'large'.repeat(1000) }) }];
    const before = structuredClone(big);
    expect(estimateContextTokens(big)).toBeGreaterThan(estimateContextTokens(small));
    expect(big).toEqual(before);
    const cyclic: Record<string, unknown> = { content: 'hello' };
    cyclic.self = cyclic;
    expect(Number.isFinite(estimateContextTokens([cyclic]))).toBe(true);
  });

  // 内联图片按文本算会高估两个数量级：1MB 的 base64 会被算成 25 万 token。实测四张真实
  // 截图（18KB/93KB/406KB/975KB）是 966/975/1751/1759——成本只随分辨率档位跳变，与
  // base64 长度几乎无关，所以小图也要按约 1,000 算。
  it('counts image blocks by picture, not by base64 characters', () => {
    const small = `data:image/png;base64,${'A'.repeat(20_000)}`;
    const large = `data:image/png;base64,${'A'.repeat(600_000)}`;
    const responses = [{ type: 'input_image', detail: 'auto', image_url: small }];
    const chat = [{ type: 'image_url', image_url: { url: large } }];
    expect(estimateContextTokens(responses)).toBeGreaterThan(900);
    expect(estimateContextTokens(responses)).toBeLessThan(1_100);
    expect(estimateContextTokens(chat)).toBeLessThan(2_000);
    expect(estimateContextTokens(chat)).toBeGreaterThan(1_600);
    // 工具输出里以 data: 开头的**文本**仍按文本算：provider 也是按文本计费的。
    const asText = [{ role: 'tool', content: large }];
    expect(estimateContextTokens(asText)).toBeGreaterThan(100_000);
  });

  // 压缩后的 notice / ctx 数字要包含系统提示词与工具定义（实测两万上下），否则一条压到
  // 5k 的历史会显示成 5k，而真实请求是 30k。测量值离确定性估算太远时退回估算值：
  // 那种差额多半是估算对正文的偏差，正文被压掉之后加回去会把数字抬得虚高。
  it('trusts the measured overhead only when it is close to the deterministic estimate', () => {
    expect(resolveRequestOverhead({ estimated: 22_000, measured: 28_000 })).toBe(28_000);
    // 测量值超过估算两倍：当它是正文估算偏差，不用。
    expect(resolveRequestOverhead({ estimated: 15_000, measured: 130_000 })).toBe(15_000);
    // 没有测量值（上次请求不是这份历史）时用确定性估算。
    expect(resolveRequestOverhead({ estimated: 22_000 })).toBe(22_000);
    expect(resolveRequestOverhead({ estimated: 0, measured: 9_000 })).toBe(9_000);
    // 负数（估算高于真实）不算开销。
    expect(resolveRequestOverhead({ estimated: 12_000, measured: -3_000 })).toBe(12_000);
  });
});
