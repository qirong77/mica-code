import Anthropic from '@anthropic-ai/sdk';
import { api } from '../store/config.js';

let _client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (_client) return _client;

  const apiKey = api.apiKey.get();
  if (!apiKey) {
    throw new Error(
      '缺少 API Key 配置，请在 ~/.mica/config.json 的 providers 中设置当前 provider 的 api_key，或配置对应环境变量',
    );
  }

  _client = new Anthropic({
    apiKey,
    baseURL: api.baseUrl.get(),
  });
  return _client;
}

export function resetClient(): void {
  _client = null;
}
