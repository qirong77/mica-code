import { EFFORT_OPTIONS, type EffortOption, type ModelRule, type ProviderProtocol } from './types.js';

type RegisteredModelRule = Omit<ModelRule, 'name' | 'modelKeysIncludes'>;
type ModelRuleResolver = (modelName: string, signal?: AbortSignal) => Promise<RegisteredModelRule>;

const registeredRules = new Map<string, RegisteredModelRule>();
const pendingRules = new Map<string, Promise<ModelRule>>();
let modelRuleResolver: ModelRuleResolver | undefined;

export function registerModelRules(rules: Record<string, RegisteredModelRule>): () => void {
  const registered = Object.keys(rules);
  for (const [model, rule] of Object.entries(rules)) registeredRules.set(model, rule);
  return () => {
    for (const model of registered) registeredRules.delete(model);
  };
}

export function registerModelRuleResolver(resolver: ModelRuleResolver): () => void {
  modelRuleResolver = resolver;
  return () => {
    if (modelRuleResolver === resolver) modelRuleResolver = undefined;
  };
}

export async function ensureModelRule(modelName: string, signal?: AbortSignal): Promise<ModelRule> {
  if (registeredRules.has(modelName)) return getModelRule(modelName);
  if (!modelRuleResolver) return getModelRule(modelName);

  const existing = pendingRules.get(modelName);
  if (existing) return existing;

  const pending = modelRuleResolver(modelName, signal)
    .then((rule) => {
      registeredRules.set(modelName, rule);
      return getModelRule(modelName);
    })
    .catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return getModelRule(modelName);
    })
    .finally(() => pendingRules.delete(modelName));
  pendingRules.set(modelName, pending);
  return pending;
}

export function getModelRule(modelName: string): ModelRule {
  const registered = registeredRules.get(modelName);
  if (registered) return { name: modelName, modelKeysIncludes: [modelName], ...registered };
  return {
    name: modelName,
    modelKeysIncludes: [modelName],
    contextSize: 1000000,
    defaultEffort: 'medium',
    efforts: Object.fromEntries(EFFORT_OPTIONS.map((effort) => [effort, {}])),
  };
}

export function getModelEffortOptions(modelName: string): EffortOption[] {
  return Object.keys(getModelRule(modelName).efforts).filter((value): value is EffortOption =>
    EFFORT_OPTIONS.includes(value as EffortOption),
  );
}

export function normalizeModelEffort(modelName: string, effort: EffortOption): EffortOption {
  const rule = getModelRule(modelName);
  return rule.efforts[effort] ? effort : rule.defaultEffort;
}

export function resolveModelRequestPatch(
  modelName: string,
  effort: EffortOption,
  protocol: ProviderProtocol,
): Record<string, unknown> | undefined {
  return getModelRule(modelName).efforts[effort]?.[protocol];
}
