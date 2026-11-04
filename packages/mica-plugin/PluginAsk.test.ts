import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PLUGIN_ASK_TIMEOUT_MS,
  MAX_PLUGIN_ASK_OPTIONS,
  MAX_PLUGIN_ASK_TIMEOUT_MS,
  normalizePluginAskQuestion,
  pluginAskSummary,
} from './PluginAsk.js';

const base = () => ({
  title: '先做哪个入口？',
  options: [
    { id: 'a', label: '方案 A：转账入口' },
    { id: 'b', label: '方案 B：钱包首页' },
  ],
});

describe('normalizePluginAskQuestion', () => {
  it('keeps option extras (prompt / command) that the client never sees', () => {
    const normalized = normalizePluginAskQuestion({
      ...base(),
      detail: '两个都能做，先做哪个。',
      options: [
        {
          id: 'a',
          label: '方案 A',
          description: '一周能上线',
          prompt: '按方案 A 实施',
          command: 'npm run build',
        },
      ],
    });
    expect(normalized.options[0]).toEqual({
      id: 'a',
      label: '方案 A',
      description: '一周能上线',
      prompt: '按方案 A 实施',
      command: 'npm run build',
    });
    expect(normalized.detail).toBe('两个都能做，先做哪个。');
  });

  it('refuses shapes the client cannot draw', () => {
    expect(() => normalizePluginAskQuestion({ ...base(), title: '  ' })).toThrow(/title/);
    expect(() => normalizePluginAskQuestion({ title: 't', options: [] })).toThrow(/至少要有一个选项/);
    expect(() => normalizePluginAskQuestion({ title: 't', options: [{ label: 'x' }] as never })).toThrow(/缺少 id/);
    expect(() =>
      normalizePluginAskQuestion({
        title: 't',
        options: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'B' },
        ],
      }),
    ).toThrow(/重复/);
    expect(() => normalizePluginAskQuestion({ title: 't', options: [{ id: 'a' }] as never })).toThrow(/label/);
  });

  it('caps options and timeouts instead of failing the call', () => {
    const many = Array.from({ length: MAX_PLUGIN_ASK_OPTIONS + 3 }, (_, index) => ({
      id: `o${index}`,
      label: `option ${index}`,
    }));
    expect(() => normalizePluginAskQuestion({ title: 't', options: many })).toThrow(/最多/);

    expect(normalizePluginAskQuestion(base()).timeoutMs).toBe(DEFAULT_PLUGIN_ASK_TIMEOUT_MS);
    expect(normalizePluginAskQuestion({ ...base(), timeoutMs: 5 }).timeoutMs).toBe(1000);
    expect(normalizePluginAskQuestion({ ...base(), timeoutMs: 10 * 60 * 60 * 1000 }).timeoutMs).toBe(
      MAX_PLUGIN_ASK_TIMEOUT_MS,
    );
    expect(normalizePluginAskQuestion({ ...base(), timeoutMs: Number.NaN }).timeoutMs).toBe(
      DEFAULT_PLUGIN_ASK_TIMEOUT_MS,
    );
  });
});

describe('pluginAskSummary', () => {
  it('prefers the short summary and falls back to the title', () => {
    expect(pluginAskSummary({ ...base(), summary: '等你选入口' })).toBe('等你选入口');
    expect(pluginAskSummary(base())).toBe('先做哪个入口？');
    expect(pluginAskSummary({ ...base(), summary: '   ' })).toBe('先做哪个入口？');
  });
});
