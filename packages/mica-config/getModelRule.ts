import { EFFORT_OPTIONS, type EffortOption, type ModelRule, type ProviderProtocol } from './types.js';

type RegisteredModelRule = Omit<ModelRule, 'name' | 'modelKeysIncludes'>;

const registeredRules = new Map<string, RegisteredModelRule>();

export function registerModelRules(rules: Record<string, RegisteredModelRule>): () => void {
  const registered = Object.keys(rules);
  for (const [model, rule] of Object.entries(rules)) registeredRules.set(model, rule);
  return () => {
    for (const model of registered) registeredRules.delete(model);
  };
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
