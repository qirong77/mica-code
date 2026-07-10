import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const EFFORT_OPTIONS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
export const PROVIDER_PROTOCOLS = ['openai_chat_completions', 'openai_responses'] as const;
export const DEFAULT_MODEL_CONTEXT_SIZE = 256;
export const CONFIG_PATH = resolveMicaHomePath('config.json');

export type EffortOption = (typeof EFFORT_OPTIONS)[number];
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];
export type EffortMap = Record<EffortOption, EffortOption>;

export interface ProviderDefinition {
  id: string;
  name?: string;
  api_base: string;
  api_key?: string;
  protocol: ProviderProtocol;
  models?: string[];
  supportsEffort?: boolean;
  get_model_url?: string;
}

export interface PersistedMicaConfig {
  providers: ProviderDefinition[];
  serperApiKey?: string;
  [key: string]: unknown;
}

export interface IMicaConfig extends PersistedMicaConfig {
  provider: string;
  model: string;
  effort: EffortOption;
  contextWindowSize: number;
  providers: ProviderDefinition[];
}

export type ModelRule = {
  name: string;
  modelKeysIncludes: string[];
  contextSize: number;
  effortMap: EffortMap;
};

export type ResolvedEffortParams = Record<string, unknown>;

export type ConfigValidationSeverity = 'error' | 'warning';

export type ConfigValidationIssue = {
  severity: ConfigValidationSeverity;
  code: string;
  path: string;
  message: string;
  suggestion?: string;
};

export type ConfigValidationResult = {
  ok: boolean;
  issues: ConfigValidationIssue[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isEffortOption(value: unknown): value is EffortOption {
  return EFFORT_OPTIONS.includes(value as EffortOption);
}

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return PROVIDER_PROTOCOLS.includes(value as ProviderProtocol);
}

export function providerSupportsModel(provider: ProviderDefinition, model: string): boolean {
  if (!Array.isArray(provider.models) || provider.models.length === 0) return true;
  return provider.models.includes(model);
}

export function firstProviderModel(provider: ProviderDefinition | Record<string, unknown>): string | undefined {
  if (Array.isArray(provider.models)) return provider.models.find(isNonEmptyString);
  return undefined;
}

export function requireProvider(config: IMicaConfig, providerId: string): ProviderDefinition {
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Provider not found: ${providerId || '(empty)'}`);
  }
  return provider;
}

export function findProvidersForModel(config: IMicaConfig, providers: unknown[]): string[] {
  if (!isNonEmptyString(config.model)) return [];
  return providers
    .flatMap((provider) => {
      if (!isRecord(provider)) return [];
      const matchesModel = Array.isArray(provider.models) && provider.models.includes(config.model);
      return matchesModel ? [provider.id] : [];
    })
    .filter(isNonEmptyString);
}

function resolveMicaHomePath(...parts: string[]): string {
  const micaHome = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : resolve(homedir(), '.mica');
  return resolve(micaHome, ...parts);
}
