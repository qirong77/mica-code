import dotenv from 'dotenv';
import { atom } from 'nanostores';
import { createPersistedAtom } from './createPersistedAtom.js';

dotenv.config({ override: true });

export type EffortLevel = 'low' | 'medium' | 'high' | 'none';

export const EFFORT_TOKENS: Record<EffortLevel, number> = {
  none: 0,
  low: 4000,
  medium: 16000,
  high: 64000,
};

export interface ModelOption {
  name: string;
  label: string;
}

export interface EffortOption {
  name: EffortLevel;
  label: string;
}

export const api = {
  baseUrl: atom(process.env.ANTHROPIC_BASE_URL),
  apiKey: atom(process.env.ANTHROPIC_API_KEY),
};

export const model = {
  name: createPersistedAtom('model', process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash'),
  maxTokens: atom(Number(process.env.ANTHROPIC_MAX_TOKENS) || 4096),
  effort: createPersistedAtom('effort', 'low' as EffortLevel),
  options: atom<ModelOption[]>([
    { name: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  ]),
  contextWindowSize: atom(1000000),
  effortOptions: atom<EffortOption[]>([
    { name: 'none', label: 'None' },
    { name: 'low', label: 'Low' },
    { name: 'medium', label: 'Medium' },
    { name: 'high', label: 'High' },
  ]),
};
