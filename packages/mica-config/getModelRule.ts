import {
  isEffortLevelName,
  KNOWN_EFFORT_LEVELS,
  type EffortOption,
  type ModelRule,
  type ProviderDefinition,
  type ProviderProtocol,
} from './types.js';

type RegisteredModelRule = Omit<ModelRule, 'name' | 'modelKeysIncludes'>;
/**
 * 解析档位/上下文时带上「这次请求走哪个服务商」：同一个模型名在不同网关下的档位可以不一样。
 * 只给模型名也能工作（退回模型厂商的条目），但网关特有的档位就查不到。
 */
type ModelRuleScope = { id?: string; api_base?: string };
type ModelRuleResolver = (
  modelName: string,
  signal?: AbortSignal,
  scope?: ModelRuleScope,
) => Promise<RegisteredModelRule>;
type ModelRuleSyncResolver = (modelName: string, scope?: ModelRuleScope) => RegisteredModelRule | undefined;

const registeredRules = new Map<string, RegisteredModelRule>();
const pendingRules = new Map<string, Promise<ModelRule>>();
/** 由 resolver（也就是 models.dev 元数据）填进来的键；刷新后只清这些。 */
const resolvedRuleKeys = new Set<string>();
let modelRuleResolver: ModelRuleResolver | undefined;
let modelRuleSyncResolver: ModelRuleSyncResolver | undefined;

export function registerModelRules(rules: Record<string, RegisteredModelRule>): () => void {
  const registered = Object.keys(rules);
  for (const [model, rule] of Object.entries(rules)) registeredRules.set(model, rule);
  return () => {
    for (const model of registered) registeredRules.delete(model);
  };
}

/**
 * 丢掉已经按旧元数据解析出来的规则。
 *
 * 规则一旦解析就整条缓存在进程里，而 models.dev 的在线刷新是后台完成的：启动时先按
 * 随包种子回答的模型（新模型甚至完全没有档位）会在整个进程寿命里沿用旧数据。刷新成功
 * 后清掉这批键，下一次同步读就会用新载荷重算；`registerModelRules` 注册的静态规则不动。
 */
export function clearResolvedModelRules(): void {
  for (const key of resolvedRuleKeys) registeredRules.delete(key);
  resolvedRuleKeys.clear();
  pendingRules.clear();
}

/**
 * `syncResolver` 让同步读（请求参数、`/effort` 候选、desktop 选择器）在异步解析完成前
 * 也能拿到模型元数据；没有它，启动后第一轮和所有同步调用都会退化成「未知模型」。
 */
export function registerModelRuleResolver(
  resolver: ModelRuleResolver,
  syncResolver?: ModelRuleSyncResolver,
): () => void {
  modelRuleResolver = resolver;
  if (syncResolver) modelRuleSyncResolver = syncResolver;
  return () => {
    if (modelRuleResolver === resolver) modelRuleResolver = undefined;
    if (syncResolver && modelRuleSyncResolver === syncResolver) modelRuleSyncResolver = undefined;
  };
}

export async function ensureModelRule(
  modelName: string,
  signal?: AbortSignal,
  scope?: ModelRuleScope,
): Promise<ModelRule> {
  const key = ruleKey(modelName, scope);
  if (registeredRules.has(key)) return getModelRule(modelName, scope);
  if (!modelRuleResolver) return getModelRule(modelName, scope);

  const existing = pendingRules.get(key);
  if (existing) return existing;

  const pending = modelRuleResolver(modelName, signal, scope)
    .then((rule) => {
      registeredRules.set(key, rule);
      resolvedRuleKeys.add(key);
      return getModelRule(modelName, scope);
    })
    .catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return getModelRule(modelName, scope);
    })
    .finally(() => pendingRules.delete(key));
  pendingRules.set(key, pending);
  return pending;
}

/**
 * 缓存键：带服务商时把该服务商算进去。
 *
 * 同一个模型名可能同时挂在网关和原生服务上（OpenRouter 的 `kimi-k3` 与 Moonshot 的
 * `kimi-k3` 档位不同），只按模型名缓存会让后注册的那份覆盖前一份，或者谁先解析谁说了算。
 */
function ruleKey(modelName: string, scope?: ModelRuleScope): string {
  const providerId = scope?.id?.trim();
  return providerId ? `${providerId.toLowerCase()}::${modelName}` : modelName;
}

/**
 * 未知模型：不猜档位。
 *
 * 没有任何元数据时我们既不知道该模型接受哪些档位名，也不知道它是否接受推理参数，
 * 所以 `efforts` 留空——`resolveEffortParams` 因此什么也不发。猜一份「标准五档」的
 * 后果是把 `xhigh` 之类的名字发给只认 `max` 的服务，换来一个 400。
 */
export function getModelRule(modelName: string, scope?: ModelRuleScope): ModelRule {
  const registered = registeredRules.get(ruleKey(modelName, scope));
  if (registered) return { name: modelName, modelKeysIncludes: [modelName], ...registered };
  const fromSnapshot = modelRuleSyncResolver?.(modelName, scope);
  if (fromSnapshot) return { name: modelName, modelKeysIncludes: [modelName], ...fromSnapshot };
  // 带服务商查不到时退回不带服务商的那份（进程启动早期只按模型名注册过），
  // 保证同步读至少能拿到模型厂商的元数据而不是空规则。
  if (scope) {
    const fallback = registeredRules.get(modelName);
    if (fallback) return { name: modelName, modelKeysIncludes: [modelName], ...fallback };
    const fromFallbackSnapshot = modelRuleSyncResolver?.(modelName);
    if (fromFallbackSnapshot) {
      return { name: modelName, modelKeysIncludes: [modelName], ...fromFallbackSnapshot };
    }
  }
  return {
    name: modelName,
    modelKeysIncludes: [modelName],
    contextSize: 1000000,
    defaultEffort: 'none',
    supportsVision: true,
    efforts: {},
  };
}

/**
 * 模型真实可选的档位，按已知档位顺序排，未知名字排在后面。
 *
 * 给了 `protocol` 就只保留该协议下**真的会发出去**的档位：只有开关的模型在
 * Responses 协议里没有等价字段，列出来只会让人以为选了什么，其实一条参数都没发。
 *
 * 模型没有元数据时退回 provider 自己声明的 `effortLevels`——自建网关的模型名
 * models.dev 不认识，但那台服务端确实接受哪些档位是它自己知道的。
 */
export function getModelEffortOptions(
  modelName: string,
  protocol?: ProviderProtocol,
  provider?: ProviderDefinition,
): EffortOption[] {
  const efforts = getModelRule(modelName, provider).efforts;
  if (Object.keys(efforts).length === 0) {
    return orderEffortLevels(provider?.effortLevels ?? []);
  }
  const levels = Object.entries(efforts)
    .filter(([, rule]) => !protocol || Boolean(rule?.[protocol]))
    .map(([level]) => level);
  return orderEffortLevels(levels);
}

/**
 * 模型不支持的档位收敛到它自己的默认档位。
 *
 * 模型没有任何档位元数据时保留原值：那说明我们不知道它能接受什么，贸然改成 `none`
 * 会把用户存的档位和子代理账目里的档位一起抹掉，等元数据回来也回不去了。
 * 这种值不会被发出去——`resolveEffortParams` 查不到补丁就什么都不发。
 */
export function normalizeModelEffort(
  modelName: string,
  effort: EffortOption,
  provider?: ProviderDefinition,
): EffortOption {
  const rule = getModelRule(modelName, provider);
  const levels = Object.keys(rule.efforts);
  if (levels.length === 0) {
    const declared = provider?.effortLevels ?? [];
    if (declared.length === 0) return isEffortLevelName(effort) ? effort : 'none';
    if (declared.includes(effort)) return effort;
    return declared.includes('medium') ? 'medium' : declared[declared.length - 1]!;
  }
  return rule.efforts[effort] ? effort : rule.defaultEffort;
}

export function orderEffortLevels(levels: Iterable<EffortOption>): EffortOption[] {
  const rank = (level: EffortOption): number => {
    const index = KNOWN_EFFORT_LEVELS.indexOf(level as (typeof KNOWN_EFFORT_LEVELS)[number]);
    return index === -1 ? KNOWN_EFFORT_LEVELS.length : index;
  };
  return [...new Set(levels)].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}
