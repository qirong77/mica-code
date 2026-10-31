import { getConfig } from './config.js';
import { providerForModel } from './types.js';
import type { ProviderProtocol } from './types.js';

/**
 * 「当前主配置的接口是什么」的唯一解析。
 *
 * 两个地方需要它：插件勾上「复用当前会话模型」时宿主替它填地址 / Key / 协议 / 模型
 * （没有会话上下文的一次性宿主，例如 `mica commit`）；配置页的「测试连接」也用它。
 * 两处读同一份规则，避免
 * 「页面测的是 A、会话里实际打到 B」。
 */

export type ActiveProviderConfig = {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  protocol: ProviderProtocol;
  model: string;
};

/**
 * `override` 用来跟会话走：会话在运行中切过 provider / model 之后，插件请求也该打到
 * 那一个，而不是配置页里那个全局默认。
 */
export function readActiveProviderConfig(override: { providerId?: string; model?: string } = {}): ActiveProviderConfig {
  const config = getConfig();
  // 顺序与主对话一致：会话钉住的 provider → 模型名自带的 `provider/model` 前缀 →
  // 当前默认 provider。插件「只换模型名」时才不会打到不认识这个模型的服务商上。
  const providerId = override.providerId || providerForModel(config, override.model)?.id || config.provider;
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`没有可用的模型服务商：${providerId || '(空)'}。请先在配置页添加服务商。`);
  }
  const model =
    override.model ||
    (provider.id === config.provider ? config.model : (provider.models?.[0] ?? '')) ||
    (provider.models?.[0] ?? '');
  return {
    providerId: provider.id,
    baseUrl: provider.api_base,
    apiKey: provider.api_key ?? '',
    protocol: provider.protocol,
    model,
  };
}
