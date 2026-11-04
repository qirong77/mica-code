import { describe, expect, it } from 'vitest';
import { compactRawUsage } from './rawUsage.js';

describe('compactRawUsage', () => {
  it('keeps top-level scalars and one level of details', () => {
    expect(
      compactRawUsage({
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 8 },
      }),
    ).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 8 },
    });
  });

  it('drops the per-message attribution that made sessions 30MB', () => {
    // 网关逐条回传的归因是会话体积的真正来源（实测单条 247KB、占整份文件 95%）。
    const compacted = compactRawUsage({
      prompt_tokens: 900000,
      attribution: { items: [{ message_id: 'a', tokens: 1 }, { message_id: 'b', tokens: 2 }] },
    });
    expect(compacted).toEqual({ prompt_tokens: 900000, truncated: true });
    expect(JSON.stringify(compacted).length).toBeLessThan(200);
  });

  it('drops arrays at any kept level and marks the record truncated', () => {
    // 整个子对象都被裁空时连它一起丢，不留一个 `details: {}` 的空壳。
    expect(compactRawUsage({ total_tokens: 4, details: { tiers: [1, 2, 3] } })).toEqual({
      total_tokens: 4,
      truncated: true,
    });
  });

  it('is idempotent: compacting twice changes nothing', () => {
    const once = compactRawUsage({ total_tokens: 4, attribution: { items: [1] } });
    expect(compactRawUsage(once)).toEqual(once);
  });

  it('returns undefined for values worth nothing', () => {
    expect(compactRawUsage(null)).toBeUndefined();
    expect(compactRawUsage('x')).toBeUndefined();
    expect(compactRawUsage({ items: [1, 2] })).toEqual({ truncated: true });
  });

  it('truncates oversized strings instead of keeping them', () => {
    const compacted = compactRawUsage({ raw: 'x'.repeat(5000) });
    expect(typeof compacted?.raw).toBe('string');
    expect((compacted?.raw as string).length).toBe(201);
  });
});
