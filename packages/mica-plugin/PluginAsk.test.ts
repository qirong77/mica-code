import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PLUGIN_ASK_TIMEOUT_MS,
  MAX_PLUGIN_ASK_OPTIONS,
  MAX_PLUGIN_ASK_TIMEOUT_MS,
  normalizePluginAskQuestion,
  pluginAskSummary,
  resolvePluginAskDisplay,
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

describe('resolvePluginAskDisplay', () => {
  const normalized = (input: Parameters<typeof normalizePluginAskQuestion>[0]) =>
    normalizePluginAskQuestion(input);

  it('derives a confirm bar only when the click is not final', () => {
    // 单选：点一下就交，不需要「确定」这条（能自由输入也一样，输入框按回车即可）
    expect(resolvePluginAskDisplay(normalized(base())).confirm).toBe(false);
    expect(
      resolvePluginAskDisplay(normalized({ ...base(), allowCustom: false })).confirm,
    ).toBe(false);
    expect(
      resolvePluginAskDisplay(normalized({ ...base(), multiple: true })).confirm,
    ).toBe(true);
    // 插件显式要也可以：单选时留一次确认
    expect(
      resolvePluginAskDisplay(normalized({ ...base(), ui: { confirm: true } })).confirm,
    ).toBe(true);
  });

  it('shows the input box by default and only drops it when told to', () => {
    expect(resolvePluginAskDisplay(normalized(base())).input).toBe(true);
    expect(resolvePluginAskDisplay(normalized({ ...base(), allowCustom: true })).input).toBe(true);
    expect(resolvePluginAskDisplay(normalized({ ...base(), allowCustom: false })).input).toBe(false);
    expect(resolvePluginAskDisplay(normalized({ ...base(), ui: { input: false } })).input).toBe(
      false,
    );
  });

  it('drops the detail row when there is no detail, even if ui asks for it', () => {
    expect(resolvePluginAskDisplay(normalized(base())).detail).toBe(false);
    expect(
      resolvePluginAskDisplay(normalized({ ...base(), ui: { detail: true } })).detail,
    ).toBe(false);
    expect(
      resolvePluginAskDisplay(normalized({ ...base(), detail: '一句说明' })).detail,
    ).toBe(true);
  });

  it('lets a plugin turn every element off for a bare confirm dialog', () => {
    // 自动压缩那种场景：只要标题 + 两个按钮，不要输入框、不要元信息
    const display = resolvePluginAskDisplay(
      normalized({ ...base(), ui: { input: false, meta: false, hint: false, dismiss: false } }),
    );
    expect(display).toMatchObject({ input: false, meta: false, hint: false, dismiss: false });
    expect(display.options).toBe(true);
  });

  it('defaults meta to on only when there is more than one option', () => {
    expect(resolvePluginAskDisplay(normalized(base())).meta).toBe(true);
    const single = resolvePluginAskDisplay(
      normalized({ title: '现在压缩？', options: [{ id: 'ok', label: '压缩' }] }),
    );
    expect(single.meta).toBe(false);
  });
});
