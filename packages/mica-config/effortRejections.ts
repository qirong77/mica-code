import type { ProviderDefinition } from './types.js';

/**
 * 服务端明确拒绝过的档位，按「服务商 + 模型 + 档位」记着。
 *
 * models.dev 是社区数据，同一个模型名在不同网关下的能力并不一致：`openai/gpt-6.1-terra`
 * 声明了 `none`，但某台 codex 网关只认 low…max，发出去就是 400。撞过一次就该记住，
 * 否则压缩摘要这类每次都新建客户端的路径会一遍遍重撞同一个 400。
 *
 * 放在单独一个模块里，是因为 `effort.ts`（解析请求参数）与 `getModelRule.ts`（列可选档位）
 * 都要读它，而它们互相依赖。
 */
const rejectedEffortLevels = new Set<string>();

function levelScopeKey(provider: ProviderDefinition, model: string, level: string): string {
  return `${provider.id}\u0000${provider.api_base ?? ''}\u0000${model}\u0000${level}`;
}

/** 已经知道服务端不接受的档位。 */
export function isEffortLevelRejected(provider: ProviderDefinition, model: string, level: string): boolean {
  return rejectedEffortLevels.has(levelScopeKey(provider, model, level));
}

/** provider 拒绝了带上这个档位的请求。之后同一档位不再发给这台服务商的这个模型。 */
export function markEffortLevelRejected(provider: ProviderDefinition, model: string, level: string): void {
  rejectedEffortLevels.add(levelScopeKey(provider, model, level));
}

/** 只给测试与配置重载用：忘记哪些档位被拒绝过。 */
export function resetRejectedEffortLevels(): void {
  rejectedEffortLevels.clear();
}
