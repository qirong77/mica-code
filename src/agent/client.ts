import Anthropic from '@anthropic-ai/sdk';
import { api } from '../store/config.js';

let _client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (_client) return _client;

  const apiKey = api.apiKey.get();
  if (!apiKey) {
    console.error('缺少 API Key 配置，请设置 ~/.mica/config.json 中 providers 的 api_key');
    process.exit(1);
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
