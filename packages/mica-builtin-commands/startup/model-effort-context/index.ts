import { registerModelRuleResolver } from '@packages/mica-config/getModelRule.js';
import { getModelRule, getSeedModelRule, type ModelProviderHint } from './getModelRule.js';

/**
 * mica-config 用 `{ id, api_base }` 描述「这次请求走哪个服务商」，models.dev 的解析器
 * 需要的是同一个信息的驼峰形态。转换只在这里做一次。
 */
function toHint(scope?: { id?: string; api_base?: string }): ModelProviderHint | undefined {
  if (!scope) return undefined;
  return { id: scope.id, apiBase: scope.api_base };
}

export default function setupModelEffortContext(): () => void {
  return registerModelRuleResolver(
    (modelName, signal, scope) => getModelRule(modelName, signal, toHint(scope)),
    (modelName, scope) => getSeedModelRule(modelName, toHint(scope)),
  );
}
