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

const MODEL_OPTIONS_FALLBACK: ModelOption[] = [{ name: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' }];

export interface EffortOption {
  name: EffortLevel;
  label: string;
}

export const api = {
  baseUrl: atom(process.env.ANTHROPIC_BASE_URL),
  apiKey: atom(process.env.ANTHROPIC_API_KEY),
};

export const model = {
  name: createPersistedAtom('model', process.env.ANTHROPIC_MODEL),
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
/* 
export ANTHROPIC_BASE_URL=https://api.moonshot.cn/anthropic
export ANTHROPIC_AUTH_TOKEN=${YOUR_MOONSHOT_API_KEY}
export ANTHROPIC_MODEL=kimi-k2.5
export ANTHROPIC_DEFAULT_OPUS_MODEL=kimi-k2.5
export ANTHROPIC_DEFAULT_SONNET_MODEL=kimi-k2.5
export ANTHROPIC_DEFAULT_HAIKU_MODEL=kimi-k2.5
export CLAUDE_CODE_SUBAGENT_MODEL=kimi-k2.5
export ENABLE_TOOL_SEARCH=false
claude
*/

export async function fetchModelOptions(): Promise<void> {
  let baseUrl = api.baseUrl.get();
  if (!baseUrl) {
    model.options.set(MODEL_OPTIONS_FALLBACK);
    return;
  }

  model.optionsLoading.set(true);
  model.optionsError.set(null);
  try {
    if (baseUrl.includes('deepseek.com')) {
      baseUrl = 'https://api.deepseek.com/models';
    } else if (baseUrl.includes('moonshot.cn')) {
      baseUrl = 'https://api.moonshot.cn/v1/models';
    } else {
      baseUrl = `${baseUrl.replace(/\/$/, '')}/models`;
    }
    const apiKey = api.apiKey.get();
    const res = await fetch(baseUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
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
