import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPluginLlmApi,
  describePluginLlm,
  expandEnvPlaceholders,
  isPluginLlmConfigured,
  pluginLlmSettingFields,
  resolvePluginLlmConfig,
  type PluginModelRequest,
} from './index.js';
import { validatePluginSettingValues } from './PluginSettings.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pluginLlmSettingFields', () => {
  it('exposes the four interface fields under the llm group', () => {
    const fields = pluginLlmSettingFields({});
    expect(fields.map((field) => field.key)).toEqual(['baseUrl', 'apiKey', 'protocol', 'model']);
    expect(fields.every((field) => field.group === 'llm')).toBe(true);
    // 每一项都能按会话覆盖：同一条会话换个便宜模型是常见需求。
    expect(fields.every((field) => field.perSession)).toBe(true);
  });

  it('adds a follow-main switch only when the plugin allows it', () => {
    expect(pluginLlmSettingFields({}).some((field) => field.key === 'useMainProvider')).toBe(false);
    const withFollow = pluginLlmSettingFields({ followMain: true });
    // 默认留空：没表态时按「有没有填地址」推断，不能预设 true 把老配置改走主配置。
    expect(withFollow[0]).toMatchObject({ key: 'useMainProvider', type: 'switch', default: '' });
  });

  it('requires address and model only when not following the main config', () => {
    const fields = pluginLlmSettingFields({ followMain: true, required: true });
    const baseUrl = fields.find((field) => field.key === 'baseUrl')!;
    expect(baseUrl.requiredWhen).toEqual({ key: 'useMainProvider', equals: 'false' });

    // 跟随主配置时不填不报错，关掉之后才报「不能为空」。
    expect(validatePluginSettingValues(fields, { useMainProvider: 'true' })).toEqual([]);
    expect(validatePluginSettingValues(fields, { useMainProvider: 'false' }).map((issue) => issue.key)).toEqual([
      'baseUrl',
      'model',
    ]);
  });

  it('uses the placeholder declared by the plugin', () => {
    const fields = pluginLlmSettingFields({ modelPlaceholder: 'gpt-4o-mini' });
    expect(fields.find((field) => field.key === 'model')?.placeholder).toBe('gpt-4o-mini');
  });
});

describe('resolvePluginLlmConfig', () => {
  it('reads the four fields and normalizes the protocol', () => {
    expect(
      resolvePluginLlmConfig({}, { baseUrl: ' https://x.test/v1 ', model: ' mini ', protocol: 'nonsense' }),
    ).toMatchObject({
      useMainProvider: false,
      baseUrl: 'https://x.test/v1',
      model: 'mini',
      protocol: 'openai_chat_completions',
    });
  });

  it('follows the main config when the plugin allows it and no endpoint is filled', () => {
    expect(resolvePluginLlmConfig({ followMain: true }, {}).useMainProvider).toBe(true);
    expect(resolvePluginLlmConfig({ followMain: true }, { useMainProvider: 'false' }).useMainProvider).toBe(false);
    // 填了自己的地址就用自己的：老配置不该因为「开关没写」而突然改走主配置。
    expect(resolvePluginLlmConfig({ followMain: true }, { baseUrl: 'https://x.test' }).useMainProvider).toBe(false);
    // 没声明 followMain 的插件永远用自己的配置。
    expect(resolvePluginLlmConfig({}, { useMainProvider: 'false' }).useMainProvider).toBe(false);
  });

  it('expands ${VAR} in the api key so the secret can live in the environment', () => {
    vi.stubEnv('MY_KEY', 'sk-from-env');
    expect(resolvePluginLlmConfig({}, { apiKey: '${MY_KEY}' }).apiKey).toBe('sk-from-env');
    expect(expandEnvPlaceholders('${NOT_SET}')).toBe('');
  });
});

describe('isPluginLlmConfigured', () => {
  it('treats following the main config as configured', () => {
    expect(
      isPluginLlmConfigured({
        useMainProvider: true,
        baseUrl: '',
        apiKey: '',
        model: '',
        protocol: 'openai_chat_completions',
      }),
    ).toBe(true);
  });

  it('needs both address and model otherwise', () => {
    const base = { useMainProvider: false, apiKey: '', protocol: 'openai_chat_completions' as const };
    expect(isPluginLlmConfigured({ ...base, baseUrl: 'https://x.test', model: 'm' })).toBe(true);
    expect(isPluginLlmConfigured({ ...base, baseUrl: '', model: 'm' })).toBe(false);
    expect(isPluginLlmConfigured({ ...base, baseUrl: 'https://x.test', model: '' })).toBe(false);
  });
});

describe('createPluginLlmApi', () => {
  function makeApi(values: Record<string, string>, requests: PluginModelRequest[]) {
    return createPluginLlmApi({
      spec: { followMain: true },
      readValues: () => values,
      models: async (request) => {
        requests.push(request);
        return { text: 'ok', usage: null };
      },
    });
  }

  it('fills the request from the configuration so plugins never repeat it', async () => {
    const requests: PluginModelRequest[] = [];
    const api = makeApi(
      { useMainProvider: 'false', baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'mini' },
      requests,
    );

    await api.request({ purpose: '自动起标题', system: 's', user: 'u' });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      purpose: '自动起标题',
      baseUrl: 'https://x.test/v1',
      apiKey: 'k',
      model: 'mini',
      protocol: 'openai_chat_completions',
      useMainProvider: false,
    });
  });

  it('lets the caller override the model for one request', async () => {
    const requests: PluginModelRequest[] = [];
    const api = makeApi({ baseUrl: 'https://x.test/v1', model: 'mini' }, requests);

    await api.request({ purpose: 'p', system: 's', user: 'u', model: 'cheaper' });

    expect(requests[0]?.model).toBe('cheaper');
  });

  it('passes follow-main through instead of resolving it itself', async () => {
    const requests: PluginModelRequest[] = [];
    const api = makeApi({ useMainProvider: 'true' }, requests);

    await api.request({ purpose: 'p', system: 's', user: 'u' });

    expect(requests[0]).toMatchObject({ useMainProvider: true, model: '' });
  });

  it('refuses to send a request when the interface is not configured', async () => {
    const requests: PluginModelRequest[] = [];
    const api = makeApi({ useMainProvider: 'false', baseUrl: '', model: '' }, requests);

    await expect(api.request({ purpose: 'p', system: 's', user: 'u' })).rejects.toThrow(/未配置/);
    expect(requests).toHaveLength(0);
  });

  it('reports a readable description without leaking the key', () => {
    expect(
      describePluginLlm(resolvePluginLlmConfig({ followMain: true }, { apiKey: 'sk-secret', model: 'mini' })),
    ).toBe('跟随主配置');
    const own = resolvePluginLlmConfig({}, { baseUrl: 'https://x.test', apiKey: 'sk-secret', model: 'mini' });
    expect(describePluginLlm(own)).toBe('Chat Completions · mini');
    expect(describePluginLlm(own)).not.toContain('sk-secret');
  });
});

describe('createPluginLlmApi fallback', () => {
  function setup(initial: Record<string, string>, handler: (request: PluginModelRequest) => Promise<string>) {
    const values = { ...initial };
    const requests: PluginModelRequest[] = [];
    const reported: string[] = [];
    const api = createPluginLlmApi({
      spec: { followMain: true },
      readValues: () => values,
      models: async (request) => {
        requests.push(request);
        return { text: await handler(request), usage: null };
      },
      health: {
        report: (entry) => {
          reported.push(entry.message);
        },
      },
    });
    return { api, requests, reported, values };
  }

  const ownConfig = { useMainProvider: 'false', baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'mini' };

  it('falls back to the main config when the configured endpoint fails', async () => {
    const { api, requests, reported } = setup(ownConfig, async (request) => {
      if (!request.useMainProvider) throw new Error('404 model not found');
      return 'ok';
    });

    await expect(api.request({ purpose: 'p', system: 's', user: 'u' })).resolves.toMatchObject({ text: 'ok' });

    expect(requests).toHaveLength(2);
    // 降级时连模型名一起交给主配置：那个名字在自己的接口里有、在主配置里未必有。
    expect(requests[1]).toMatchObject({ useMainProvider: true, model: '', baseUrl: '', apiKey: '' });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('404 model not found');
    expect(api.describe()).toContain('已降级');
  });

  it('remembers the failure so later requests go straight to the main config', async () => {
    const { api, requests, reported } = setup(ownConfig, async (request) => {
      if (!request.useMainProvider) throw new Error('401 unauthorized');
      return 'ok';
    });

    await api.request({ purpose: 'p', system: 's', user: 'u' });
    await api.request({ purpose: 'p', system: 's', user: 'u' });

    // 第二次不再先打一遍注定失败的地址，健康状态也只报一次。
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({ useMainProvider: true, model: '' });
    expect(reported).toHaveLength(1);
  });

  it('tries its own endpoint again after the configuration changes', async () => {
    const { api, requests, values } = setup(ownConfig, async (request) => {
      if (request.baseUrl === 'https://x.test/v1') throw new Error('503 unavailable');
      return 'ok';
    });

    await api.request({ purpose: 'p', system: 's', user: 'u' });
    expect(api.describe()).toContain('已降级');

    values.baseUrl = 'https://y.test/v1';
    await api.request({ purpose: 'p', system: 's', user: 'u' });

    expect(requests.at(-1)).toMatchObject({ useMainProvider: false, baseUrl: 'https://y.test/v1' });
    expect(api.describe()).not.toContain('已降级');
  });

  it('drops a named model the main config cannot serve', async () => {
    const { api, requests } = setup({ useMainProvider: 'true', model: 'gone-model' }, async (request) => {
      if (request.model) throw new Error('404 no such model');
      return 'ok';
    });

    await api.request({ purpose: 'p', system: 's', user: 'u' });

    expect(requests[1]).toMatchObject({ useMainProvider: true, model: '' });
  });

  it('does not retry when it already follows the main config without a named model', async () => {
    const { api, requests, reported } = setup({ useMainProvider: 'true', model: '' }, async () => {
      throw new Error('network down');
    });

    await expect(api.request({ purpose: 'p', system: 's', user: 'u' })).rejects.toThrow('network down');
    expect(requests).toHaveLength(1);
    expect(reported).toHaveLength(0);
  });

  it('does not resend after the caller aborted', async () => {
    const { api, requests } = setup(ownConfig, async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const controller = new AbortController();
    controller.abort();

    await expect(api.request({ purpose: 'p', system: 's', user: 'u', signal: controller.signal })).rejects.toThrow(
      'aborted',
    );
    expect(requests).toHaveLength(1);
  });

  it('keeps the original error and stays put when the fallback fails too', async () => {
    const { api, requests, reported } = setup(ownConfig, async (request) => {
      throw new Error(request.useMainProvider ? 'main provider down' : '404 model not found');
    });

    await expect(api.request({ purpose: 'p', system: 's', user: 'u' })).rejects.toThrow(
      /404 model not found；降级为主配置也失败：main provider down/,
    );
    // 两边都失败时不记住这次降级：下一次仍先试用户自己的配置。
    expect(api.describe()).not.toContain('已降级');
    expect(reported).toHaveLength(0);

    await expect(api.request({ purpose: 'p', system: 's', user: 'u' })).rejects.toThrow(/404 model not found/);
    expect(requests[2]).toMatchObject({ useMainProvider: false });
  });
});
