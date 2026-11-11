import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import type { ModelRule, ModelRequestPatch } from './types.js';
import type { ProviderProtocol } from './providerProtocol.js';

type NativeProtocol = Extract<ProviderProtocol, 'anthropic_messages' | 'google_generative_ai'>;
type NativeRule = Omit<ModelRule, 'name' | 'modelKeysIncludes'>;

// These factories only read Pi's bundled catalogs. They do not resolve credentials or fetch models.
const catalogs = {
  anthropic_messages: anthropicProvider().getModels(),
  google_generative_ai: googleProvider().getModels(),
};
const anthropicEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const googleEfforts = new Set(['minimal', 'low', 'medium', 'high']);

export function isNativeProtocol(protocol: ProviderProtocol | undefined): protocol is NativeProtocol {
  return protocol === 'anthropic_messages' || protocol === 'google_generative_ai';
}

/** Payload patches use Pi's onPayload shape, including Google SDK's `config` wrapper. */
export function nativeEffortPatch(protocol: NativeProtocol, level: string): ModelRequestPatch | undefined {
  if (protocol === 'anthropic_messages') {
    if (level === 'none') return { thinking: { type: 'disabled' } };
    if (!anthropicEfforts.has(level)) return undefined;
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: level },
    };
  }
  if (level === 'none') return { config: { thinkingConfig: { thinkingBudget: 0 } } };
  if (!googleEfforts.has(level)) return undefined;
  return { config: { thinkingConfig: { includeThoughts: true, thinkingLevel: level.toUpperCase() } } };
}

/** Native levels are Pi's provider values, never aliases from its uniform simple-stream API. */
export function getNativeModelRule(modelName: string, protocol?: ProviderProtocol): NativeRule | undefined {
  if (!isNativeProtocol(protocol)) return undefined;
  const requested = modelName.toLowerCase();
  const basename = requested.split('/').at(-1);
  const model =
    catalogs[protocol].find((entry) => entry.id.toLowerCase() === requested) ??
    catalogs[protocol].find((entry) => entry.id.toLowerCase() === basename);
  if (!model) return undefined;

  const efforts: ModelRule['efforts'] = {};
  // A budget-only model has no named native levels. Pi's simple API invents token budgets
  // for those models; Mica keeps its existing contract of not presenting those as effort choices.
  const namedLevels =
    model.reasoning &&
    (protocol === 'anthropic_messages'
      ? model.compat?.forceAdaptiveThinking === true
      : model.thinkingLevelMap !== undefined);
  if (namedLevels) {
    for (const level of getSupportedThinkingLevels(model)) {
      const mapped = model.thinkingLevelMap?.[level];
      const native = level === 'off' ? 'none' : typeof mapped === 'string' ? mapped.toLowerCase() : level;
      const patch = nativeEffortPatch(protocol, native);
      if (patch) efforts[native] = { [protocol]: patch };
    }
  }
  const levels = Object.keys(efforts);
  return {
    contextSize: model.contextWindow,
    supportsVision: model.input.includes('image'),
    defaultEffort: levels.includes('medium') ? 'medium' : levels.includes('high') ? 'high' : (levels[0] ?? 'none'),
    efforts,
  };
}
