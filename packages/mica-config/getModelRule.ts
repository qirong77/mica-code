import type { ModelRule } from './types.js';

export function getModelRule(modelName: string): ModelRule {
  return {
    name: modelName,
    modelKeysIncludes: [modelName],
    contextSize: 1000000,
    effortMap: { none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
  };
}
