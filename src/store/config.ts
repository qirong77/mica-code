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

interface ApiModelItem {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ApiModelListResponse {
  data: ApiModelItem[];
  object: string;
}

const MODEL_OPTIONS_FALLBACK: ModelOption[] = [
  { name: 'Sonnet 4.6', label: 'Sonnet 4.6' },
];

export interface EffortOption {
  name: EffortLevel;
  label: string;
}

export const api = {
  baseUrl: atom(process.env.ANTHROPIC_BASE_URL),
  apiKey: atom(process.env.ANTHROPIC_API_KEY),
};

export const model = {
  name: createPersistedAtom('model', process.env.ANTHROPIC_MODEL || 'kimi-k2.5-external'),
  maxTokens: atom(Number(process.env.ANTHROPIC_MAX_TOKENS) || 4096),
  effort: createPersistedAtom('effort', 'low' as EffortLevel),
  options: atom<ModelOption[]>(MODEL_OPTIONS_FALLBACK),
  optionsLoading: atom(false),
  optionsError: atom<string | null>(null),
  contextWindowSize: atom(1000000),
  effortOptions: atom<EffortOption[]>([
    { name: 'none', label: 'None' },
    { name: 'low', label: 'Low' },
    { name: 'medium', label: 'Medium' },
    { name: 'high', label: 'High' },
  ]),
};

export async function fetchModelOptions(): Promise<void> {
  const baseUrl = api.baseUrl.get();
  if (!baseUrl) {
    model.options.set(MODEL_OPTIONS_FALLBACK);
    return;
  }

  model.optionsLoading.set(true);
  model.optionsError.set(null);

  try {
    const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as ApiModelListResponse;
    if (!json.data || !Array.isArray(json.data)) {
      throw new Error('invalid response format');
    }

    const options: ModelOption[] = json.data
      .filter((m) => m.id)
      .map((m) => ({ name: m.id, label: m.id }));

    if (options.length > 0) {
      model.options.set(options);
    }
  } catch (err) {
    model.optionsError.set(err instanceof Error ? err.message : String(err));
    model.options.set(MODEL_OPTIONS_FALLBACK);
  } finally {
    model.optionsLoading.set(false);
  }
}
