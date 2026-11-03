import type { ProviderDefinition } from '@packages/mica-config/index.js';

/**
 * 流结束却一次都没有 `finish_reason` 的服务商，按「服务商 + 地址 + 模型」记着。
 *
 * `finish_reason` 是判断「这条流是不是被截断」的唯一依据，绝大多数服务商都会发。
 * 少数兼容网关整条流都不发这个字段：对它严格判定等于每次请求都失败，重发也还是
 * 一样。重发一次仍然没有，就认定这台服务商不报它，之后按「流正常结束」处理——
 * 只在这一个进程里记住，配置换了地址或模型自然会重新判定。
 */
const silentProviders = new Set<string>();

function scopeKey(provider: ProviderDefinition, model: string): string {
  return `${provider.id}\u0000${provider.api_base ?? ''}\u0000${model}`;
}

/** 已经确认这台服务商不报 `finish_reason`。 */
export function providerOmitsFinishReason(provider: ProviderDefinition, model: string): boolean {
  return silentProviders.has(scopeKey(provider, model));
}

export function markProviderOmitsFinishReason(provider: ProviderDefinition, model: string): void {
  silentProviders.add(scopeKey(provider, model));
}

/** 只给测试用。 */
export function resetFinishReasonSupport(): void {
  silentProviders.clear();
}
