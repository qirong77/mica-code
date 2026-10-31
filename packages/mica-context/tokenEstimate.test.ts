import { describe, expect, it } from 'vitest';
import { estimateContextTokens, estimateTextTokens } from './tokenEstimate.js';

describe('local token estimation', () => {
  it('handles empty, ASCII and CJK without serializing the history', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('a'.repeat(4000))).toBe(1000);
    expect(estimateTextTokens('中文'.repeat(1000))).toBe(3000);
    const payload = { role: 'tool', content: 'value'.repeat(100_000), toJSON() { throw new Error('must not serialize'); } };
    expect(estimateContextTokens([payload])).toBeGreaterThan(100_000);
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
});
