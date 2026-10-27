import { getModelRule } from './getModelRule.js';
import type { EffortOption, ProviderDefinition, ProviderProtocol, ResolvedEffortParams } from './types.js';

export type EffortParamsRequest = {
  provider: ProviderDefinition;
  model: string;
  /** 未指定按 `none` 处理：调用方没有要求推理强度时按「不请求推理」发。 */
  effort: EffortOption | undefined;
  protocol: ProviderProtocol;
};

/**
 * effort 到 wire 参数的唯一入口：发什么完全由模型规则决定，没有任何别名换算。
 *
 * 顺序固定为 provider 声明 → 模型规则。反过来会让模型补丁绕过
 * `supportsEffort: false`，把用户明确关掉的能力又发出去。
 *
 * 规则里没有该档位（模型不支持这一档、该协议没有等价参数、模型未知）时返回空对象：
 * 宁可不发，也不发一个未必被接受的猜测值。唯一例外是 provider 自己用 `effortLevels`
 * 声明了这个档位——那是服务端所有者给出的真实取值，直接按名字发。
 */
export function resolveEffortParams({ provider, model, effort, protocol }: EffortParamsRequest): ResolvedEffortParams {
  if (provider.supportsEffort === false) return {};
  const level = effort ?? 'none';
  const rule = getModelRule(model);
  const fromModel = rule.efforts[level]?.[protocol];
  if (fromModel) return fromModel;
  if (Object.keys(rule.efforts).length > 0) return {};
  if (!provider.effortLevels?.includes(level)) return {};
  return protocol === 'openai_responses' ? { reasoning: { effort: level } } : { reasoning_effort: level };
}
