import { describe, expect, it } from 'vitest';
import { createPluginLlmApi, type PluginModelRequest } from '@packages/mica-plugin/index.js';
import manifest from './plugin.json';
import { DEFAULT_PROMPT } from './index.js';
import { requestSessionTitle, sanitizeTitle } from './titleRequest.js';

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

  it('caps very long titles', () => {
    const title = sanitizeTitle('很'.repeat(120));
    expect(title.length).toBe(60);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('llm readiness', () => {
  const build = (values: Record<string, string>) =>
    createPluginLlmApi({ spec: {}, readValues: () => values, models: async () => ({ text: '', usage: null }) });

  it('needs both base url and model', () => {
    const base = { baseUrl: 'https://api.openai.com/v1', apiKey: 'k' };
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
