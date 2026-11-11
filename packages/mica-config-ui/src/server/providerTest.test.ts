import { describe, expect, it, vi } from 'vitest';
import * as micaAgent from '@packages/mica-agent/index.js';
import { testProviderConnection } from './providerTest.js';
import { PROVIDER_PROTOCOLS } from '@packages/mica-config/providerProtocol.js';

describe('testProviderConnection', () => {
  it.each(PROVIDER_PROTOCOLS)('probes the current form values using %s', async (protocol) => {
    const probe = vi.spyOn(micaAgent, 'probeModelConnection').mockResolvedValue({
      ok: true,
      message: '',
      model: 'deepseek-chat',
      latencyMs: 12,
      reply: 'OK',
    });

    const result = await testProviderConnection({
      apiBase: ' https://api.deepseek.com ',
      apiKey: 'sk-test',
      protocol,
      model: ' deepseek-chat ',
    });

    expect(probe).toHaveBeenCalledWith({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      protocol,
      model: 'deepseek-chat',
    });
    expect(result).toMatchObject({ ok: true, model: 'deepseek-chat' });
  });

  it('treats an empty key as no authentication', async () => {
    const probe = vi.spyOn(micaAgent, 'probeModelConnection').mockResolvedValue({
      ok: true,
      message: '',
      model: 'local-model',
      latencyMs: 3,
    });

    await testProviderConnection({
      apiBase: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      protocol: 'openai_responses',
      model: 'local-model',
    });

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('answers without a request when the form is not usable yet', async () => {
    const probe = vi.spyOn(micaAgent, 'probeModelConnection');

    await expect(
      testProviderConnection({ apiBase: 'https://api.test', protocol: 'openai_chat_completions', model: ' ' }),
    ).resolves.toMatchObject({ ok: false, message: '先给这个服务商填一个模型，才能发请求验证' });
    await expect(
      testProviderConnection({ apiBase: 'https://api.test', protocol: 'grpc', model: 'm' }),
    ).resolves.toMatchObject({ ok: false, message: '请选择支持的模型协议' });
    expect(probe).not.toHaveBeenCalled();
  });
});
