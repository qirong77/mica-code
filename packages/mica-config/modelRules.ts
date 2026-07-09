import modelRules from './model-rules.json';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  CONFIG_PATH,
  DEFAULT_MODEL_CONTEXT_SIZE,
  isEffortOption,
  isNonEmptyString,
  type EffortMap,
  type EffortOption,
  type ModelRule,
} from './types.js';

export const DEFAULT_EFFORT_MAP: EffortMap = {
  none: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
};

const REMOTE_MODEL_RULES_URL =
  'https://raw.githubusercontent.com/qirong77/mica-code/main/packages/mica-config/model-rules.json';
const MODEL_RULES_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MODEL_RULES_CACHE_PATH = resolve(dirname(CONFIG_PATH), 'model-rules.json');

let MODEL_RULES = loadCachedModelRules() ?? (modelRules as ModelRule[]);

export async function refreshModelRulesFromRemote(now = Date.now()): Promise<boolean> {
  if (!shouldRefreshModelRules(now)) return false;
  try {
    const response = await fetch(REMOTE_MODEL_RULES_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const rules = parseModelRules((await response.json()) as unknown);
    if (!rules) return false;
    MODEL_RULES = rules;
    writeFileSync(MODEL_RULES_CACHE_PATH, `${JSON.stringify(rules, null, 2)}\n`, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function getEffortMapFromConfig(modelId: string): EffortMap | null {
  const rule = findModelRule(modelId);
  if (rule?.enableEffort === false) return null;
  return rule?.effortMap ?? DEFAULT_EFFORT_MAP;
}

export function getModelContextWindowSizeFromConfig(modelId: string): number {
  return parseModelContextSize(findModelRule(modelId)?.contextSize ?? DEFAULT_MODEL_CONTEXT_SIZE);
}

export function hasOwnEffort(effortMap: EffortMap, effort: EffortOption): boolean {
  return Object.prototype.hasOwnProperty.call(effortMap, effort);
}

function findModelRule(modelId: string): ModelRule | undefined {
  const normalizedModelId = modelId.toLowerCase();
  return MODEL_RULES.find((rule) =>
    rule.modelKeysIncludes.map((key) => key.toLowerCase()).some((key) => normalizedModelId.includes(key)),
  );
}

function parseModelContextSize(value: number | string): number {
  if (typeof value === 'number') return Math.max(1, Math.round(value * 1000));
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) return DEFAULT_MODEL_CONTEXT_SIZE * 1000;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return DEFAULT_MODEL_CONTEXT_SIZE * 1000;
  const unit = match[2];
  if (unit === 'm') return Math.round(amount * 1_000_000);
  return Math.round(amount * 1000);
}

function shouldRefreshModelRules(now: number): boolean {
  try {
    if (!existsSync(MODEL_RULES_CACHE_PATH)) return true;
    return now - statSync(MODEL_RULES_CACHE_PATH).mtimeMs >= MODEL_RULES_REFRESH_INTERVAL_MS;
  } catch {
    return true;
  }
}

function loadCachedModelRules(): ModelRule[] | null {
  try {
    if (!existsSync(MODEL_RULES_CACHE_PATH)) return null;
    return parseModelRules(JSON.parse(readFileSync(MODEL_RULES_CACHE_PATH, 'utf-8')));
  } catch {
    return null;
  }
}

function parseModelRules(value: unknown): ModelRule[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isModelRule)) return null;
  return value;
}

function isModelRule(value: unknown): value is ModelRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Partial<ModelRule>;
  if (rule.name !== undefined && typeof rule.name !== 'string') return false;
  if (!Array.isArray(rule.modelKeysIncludes) || !rule.modelKeysIncludes.every(isNonEmptyString)) return false;
  if (rule.contextSize !== undefined && typeof rule.contextSize !== 'number' && typeof rule.contextSize !== 'string') {
    return false;
  }
  if (rule.enableEffort !== undefined && typeof rule.enableEffort !== 'boolean') return false;
  if (rule.effortMap !== undefined && !isEffortMap(rule.effortMap)) return false;
  return true;
}

function isEffortMap(value: unknown): value is EffortMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([effort, mapped]) => isEffortOption(effort) && (mapped === null || typeof mapped === 'string'),
  );
}
