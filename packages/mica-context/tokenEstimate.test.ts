import type { Message } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { estimateContextTokens, estimateTextTokens, resolveRequestOverhead } from './tokenEstimate.js';
import { assistant, image, text, toolCall, toolResult, user } from './testFixtures.js';

describe('local token estimation for pi messages', () => {
  it('handles empty, ASCII and CJK without serializing the history', () => {
    expect(estimateContextTokens([])).toBe(0);
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('a '.repeat(2000))).toBe(1020);
    expect(estimateTextTokens('中文对话'.repeat(1000))).toBe(2600);
    const payload = { ...toolResult('a', 'test', 'value'.repeat(100_000)), toJSON() { throw new Error('must not serialize'); } };
    expect(estimateContextTokens([payload])).toBeGreaterThan(100_000);
  });

  it('weights CJK and dense payloads using measured character ratios', () => {
    const chinese = '我们的会话压缩把工具结果换成占位符'.repeat(100);
    expect(estimateTextTokens(chinese) / chinese.length).toBeGreaterThan(0.5);
    expect(estimateTextTokens(chinese) / chinese.length).toBeLessThan(0.85);
    const payload = 'iVBORw0KGgoAAAANSUhEUg'.repeat(2000);
    expect(estimateTextTokens(payload) / payload.length).toBeGreaterThan(0.6);
    expect(estimateTextTokens(payload) / payload.length).toBeLessThan(0.8);
  });

  it('counts nested structured arguments including keys, without mutating them', () => {
    const small = [assistant([toolCall('a', 'write_file', { options: { file: 'small' } })])];
    const big = [assistant([toolCall('a', 'write_file', { options: { file: 'large'.repeat(1000) } })])];
    const before = structuredClone(big);
    expect(estimateContextTokens(big)).toBeGreaterThan(estimateContextTokens(small));
    expect(estimateContextTokens([assistant([toolCall('a', 'write_file', { ['long-key-'.repeat(100)]: 1 })])])).toBeGreaterThan(estimateContextTokens(small));
    expect(big).toEqual(before);
  });

  it('counts user and tool images by picture while base64 text remains text', () => {
    const small = [user([image('A'.repeat(20_000))])];
    const large = [toolResult('a', 'read_image', [image('A'.repeat(600_000))])];
    expect(estimateContextTokens(small)).toBeGreaterThan(900);
    expect(estimateContextTokens(small)).toBeLessThan(1100);
    expect(estimateContextTokens(large)).toBeGreaterThan(1600);
    expect(estimateContextTokens(large)).toBeLessThan(2000);
    expect(estimateContextTokens([toolResult('a', 'read_image', 'data:image/png;base64,' + 'A'.repeat(600_000))])).toBeGreaterThan(100_000);
    expect(estimateContextTokens([user([image(), image()])])).toBe(2002);
  });

  it('ignores thinking, signatures, model metadata, usage, and non-context tool details', () => {
    const plain = assistant([text('visible'), toolCall('a', 'probe', { path: 'a.ts' })]);
    const decorated = assistant([
      { type: 'thinking', thinking: 'secret'.repeat(100_000), thinkingSignature: 'opaque'.repeat(100_000) },
      { type: 'text', text: 'visible', textSignature: 'text'.repeat(100_000) },
      { ...toolCall('different-call-id'.repeat(1000), 'probe', { path: 'a.ts' }), thoughtSignature: 'tool'.repeat(100_000) },
    ], {
      api: 'anthropic-messages', provider: 'provider'.repeat(1000), model: 'model'.repeat(1000), responseId: 'response'.repeat(1000),
      usage: { ...plain.usage, input: 1_000_000, output: 900_000, totalTokens: 1_900_000 }, timestamp: 999_999_999_999,
    });
    const result = toolResult('a', 'probe', 'visible result');
    const decoratedResult = { ...result, toolName: 'tool'.repeat(1000), toolCallId: 'id'.repeat(1000), details: { data: 'huge'.repeat(100_000) }, usage: decorated.usage };
    expect(estimateContextTokens([decorated, decoratedResult])).toBe(estimateContextTokens([plain, result]));
    expect(estimateContextTokens([user([text('visible')])])).toBe(estimateContextTokens([user('visible')]));
  });

  it('uses pi system rendering for prompt sections and includes declared tools', () => {
    const system: Message = { role: 'system', content: 'base', sections: { task: 'task instructions' }, timestamp: 0 };
    expect(estimateContextTokens([system])).toBeGreaterThan(estimateContextTokens([{ ...system, sections: {} }]));
    expect(estimateContextTokens([{ ...system, toolsRemoved: [{ name: 'read_file' }] }])).toBeGreaterThan(estimateContextTokens([system]));
  });

  it('uses measured overhead only when it is close to the deterministic estimate', () => {
    expect(resolveRequestOverhead({ estimated: 22_000, measured: 28_000 })).toBe(28_000);
    expect(resolveRequestOverhead({ estimated: 15_000, measured: 130_000 })).toBe(15_000);
    expect(resolveRequestOverhead({ estimated: 22_000 })).toBe(22_000);
    expect(resolveRequestOverhead({ estimated: 0, measured: 9000 })).toBe(9000);
    expect(resolveRequestOverhead({ estimated: 12_000, measured: -3000 })).toBe(12_000);
  });
});
