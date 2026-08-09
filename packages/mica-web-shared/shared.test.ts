import { describe, expect, it } from 'vitest';
import { contextUsage, modelLabel, toolIcon, toolLabel, tokenCount, formatElapsedMs, usageValues } from './index.js';

describe('mica-web-shared tools', () => {
  it('maps builtin tools to stable icons and labels', () => {
    expect(toolIcon('run_shell')).toBe('⚡️');
    expect(toolIcon('read_file')).toBe('📖');
    expect(toolIcon('unknown_tool')).toBe('⚙');
    expect(toolIcon(null)).toBe('⚙');
    expect(toolLabel('run_shell')).toBe('Shell');
    expect(toolLabel('grep_search')).toBe('Search code');
    expect(toolLabel('unknown_tool')).toBe('unknown_tool');
  });

  it('renders MCP tools with server prefix and stripped hash', () => {
    expect(toolIcon('mcp__server__tool_ab12cd34')).toBe('🔌');
    expect(toolLabel('mcp__server__tool_ab12cd34')).toBe('[MCP:server] tool');
    expect(toolLabel('mcp__server__tool')).toBe('[MCP:server] tool');
  });
});

describe('mica-web-shared token/elapsed formatting', () => {
  it('tokenCount compacts thousands and millions', () => {
    expect(tokenCount(900)).toBe('900');
    expect(tokenCount(1234)).toBe('1.2K');
    expect(tokenCount(45_300)).toBe('45K');
    expect(tokenCount(2_100_000)).toBe('2.1M');
    expect(tokenCount(0)).toBe('');
    expect(tokenCount(Number.NaN)).toBe('');
  });

  it('formatElapsedMs matches the desktop tool-row grammar', () => {
    expect(formatElapsedMs(-1)).toBe('0ms');
    expect(formatElapsedMs(312)).toBe('312ms');
    expect(formatElapsedMs(8_400)).toBe('8.4s');
    expect(formatElapsedMs(133_000)).toBe('2m 13s');
  });
});

describe('mica-web-shared usage/context', () => {
  it('normalizes provider usage shapes', () => {
    expect(usageValues({ total_tokens: 100, prompt_tokens: 60, completion_tokens: 40 })).toEqual({
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      cachedInputTokens: 0,
    });
    expect(usageValues({ totalTokens: 5, inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 })).toEqual({
      totalTokens: 5,
      inputTokens: 3,
      outputTokens: 2,
      cachedInputTokens: 1,
    });
    expect(usageValues(null)).toBeNull();
    expect(usageValues({})).toBeNull();
  });

  it('modelLabel omits none effort', () => {
    expect(modelLabel('deepseek-v4-flash', 'high')).toBe('deepseek-v4-flash_high');
    expect(modelLabel('deepseek-v4-flash', 'none')).toBe('deepseek-v4-flash');
    expect(modelLabel('deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(modelLabel('')).toBe('');
  });

  it('contextUsage computes tokens, cached%, ctx% and tone', () => {
    const result = contextUsage({
      usage: { totalTokens: 600_000, inputTokens: 400_000, cachedInputTokens: 300_000 },
      model: 'deepseek-v4-flash',
      contextWindowSize: 1_000_000,
    });
    expect(result).toEqual({ tokens: 600_000, cachedPct: 75, contextPct: 60, tone: 'mid' });
    expect(contextUsage({ usage: null, model: 'x' })).toBeNull();
    expect(contextUsage({ usage: { totalTokens: 0 }, model: 'x' })).toBeNull();
  });
});
