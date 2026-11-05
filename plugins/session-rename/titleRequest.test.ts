import { describe, expect, it } from 'vitest';
import { createPluginLlmApi, type PluginModelRequest } from '@packages/mica-plugin/index.js';
import manifest from './plugin.json';
import { DEFAULT_PROMPT } from './index.js';
import { requestSessionTitle, sanitizeTitle, titleRejectionReason } from './titleRequest.js';

describe('sanitizeTitle', () => {
  it('takes the first line and strips decoration', () => {
    expect(sanitizeTitle('标题：修复登录超时\n说明：改了 fetch')).toBe('修复登录超时');
    expect(sanitizeTitle('```\n**重构压缩策略**\n```')).toBe('重构压缩策略');
    expect(sanitizeTitle('"会话改名插件"')).toBe('会话改名插件');
    expect(sanitizeTitle('- 调整插件加载器。')).toBe('调整插件加载器');
  });

  it('rejects empty or non-text answers', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle('   \n  ')).toBe('');
    expect(sanitizeTitle(undefined)).toBe('');
    expect(sanitizeTitle({ title: 'x' })).toBe('');
  });

  it('preserves long answers for validation rather than silently truncating them', () => {
    const title = sanitizeTitle('很'.repeat(120));
    expect(title).toBe('很'.repeat(120));
    expect(titleRejectionReason(title)).toBe('too-long');
  });
});

describe('titleRejectionReason', () => {
  it.each([
    '修复登录超时',
    '重构压缩策略',
    '完善 session-rename 标题校验',
    'Fix login timeout',
    'Investigate flaky tests',
    '会话处理器性能优化',
    '已修复登录超时',
    '已完成页面改版',
    '首先加载配置失败',
    '先检查配置',
    '我'.repeat(20),
    'a'.repeat(40),
  ])('accepts a concise title: %s', (title) => {
    expect(titleRejectionReason(title)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['我'.repeat(21), 'too-long'],
    ['a'.repeat(41), 'too-long'],
    ['修复登录超时后我会继续检查连接并把结果同步给你', 'too-long'],
    ['我会先检查连接', 'process-statement'],
    ['先核对共享工作区，再分开修改和验证', 'process-statement'],
    ['我们已经修复这个问题', 'process-statement'],
    ['接下来我会检查测试', 'process-statement'],
    ['I will check the code', 'process-statement'],
    ["Let's inspect the implementation", 'process-statement'],
  ] as const)('rejects %s as %s', (title, reason) => {
    expect(titleRejectionReason(title)).toBe(reason);
  });
});

describe('llm readiness', () => {
  const build = (values: Record<string, string>) =>
    createPluginLlmApi({ spec: {}, readValues: () => values, models: async () => ({ text: '', usage: null }) });

  it('needs both base url and model', () => {
    // 默认复用会话模型；这条测的是「用自己的接口」时的完整性判定。
    const base = { useMainProvider: 'false', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' };
    expect(build({ ...base, model: 'gpt-4o-mini' }).configured()).toBe(true);
    expect(build({ ...base, model: '  ' }).configured()).toBe(false);
    expect(build({ ...base, baseUrl: ' ', model: 'm' }).configured()).toBe(false);
  });
});

describe('requestSessionTitle', () => {
  it('asks the host for one request with the configured endpoint and prompt', async () => {
    const requests: PluginModelRequest[] = [];
    const llm = createPluginLlmApi({
      spec: {},
      readValues: () => ({
        useMainProvider: 'false',
        baseUrl: 'https://example.test/v1',
        apiKey: 'secret',
        protocol: 'openai_responses',
        model: 'mini',
      }),
      models: async (request) => {
        requests.push(request);
        return { text: '**修复登录超时**', usage: null };
      },
    });

    const result = await requestSessionTitle(llm, { prompt: '只输出标题' }, 'user: 修一下登录超时');

    expect(requests[0]).toMatchObject({
      purpose: '自动起标题',
      system: '只输出标题',
      user: 'user: 修一下登录超时',
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret',
      protocol: 'openai_responses',
      model: 'mini',
    });
    expect(result).toEqual({ title: '修复登录超时', usage: null });
  });
});

describe('plugin manifest', () => {
  it('ships the same default prompt as the code fallback', () => {
    const field = manifest.settings.find((entry) => entry.key === 'prompt');
    expect(field?.default).toBe(DEFAULT_PROMPT);
  });

  it('declares the fields the plugin actually reads', () => {
    const keys = manifest.settings.map((entry) => entry.key);
    expect(keys).toEqual(expect.arrayContaining(['prompt', 'maxMessages', 'minIntervalSeconds']));
    // 模型接口由清单的 `llm` 声明生成，不再手写四个字段。
    expect(manifest.llm).toMatchObject({ modelPlaceholder: 'gpt-4o-mini' });
  });
});
