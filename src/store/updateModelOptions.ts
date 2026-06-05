import { model, api, MODEL_OPTIONS_FALLBACK } from './config.js';
import type { ModelOption, ApiModelListResponse } from './config.js';

/* TODO: 兼容 claude 的环境变量
export ANTHROPIC_BASE_URL=https://api.moonshot.cn/anthropic
export ANTHROPIC_AUTH_TOKEN=${YOUR_MOONSHOT_API_KEY}
export ANTHROPIC_MODEL=kimi-k2.5
export ANTHROPIC_DEFAULT_OPUS_MODEL=kimi-k2.5
export ANTHROPIC_DEFAULT_SONNET_MODEL=kimi-k2.5
export ANTHROPIC_DEFAULT_HAIKU_MODEL=kimi-k2.5
export CLAUDE_CODE_SUBAGENT_MODEL=kimi-k2.5
export ENABLE_TOOL_SEARCH=false
*/


function resolveModelsUrl(baseUrl: string): string {
  if (baseUrl.includes('deepseek.com')) return 'https://api.deepseek.com/models';
  if (baseUrl.includes('moonshot.cn')) return 'https://api.moonshot.cn/v1/models';
  return `${baseUrl.replace(/\/$/, '')}/models`;
}

async function fetchModelList(url: string, apiKey: string | undefined): Promise<ModelOption[]> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = (await res.json()) as ApiModelListResponse;
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error('invalid response format');
  }
  return json.data.filter((m) => m.id).map((m) => ({ name: m.id, label: m.id }));
}

function applyModelOptions(options: ModelOption[]): void {
  if (options.length === 0) return;
  model.options.set(options);

  const current = model.name.get();
  if (!options.some((opt) => opt.name === current)) {
    model.name.set(options[0].name);
  }
}

function applyFallbackOptions(error: string): void {
  model.optionsError.set(error);
  const envModel = process.env.ANTHROPIC_MODEL;
  model.options.set(
    envModel ? [{ name: envModel, label: envModel }] : MODEL_OPTIONS_FALLBACK,
  );
}

export async function updateModelOptions(): Promise<void> {
  const baseUrl = api.baseUrl.get();
  if (!baseUrl) {
    model.options.set(MODEL_OPTIONS_FALLBACK);
    return;
  }

  model.optionsLoading.set(true);
  model.optionsError.set(null);

  try {
    const url = resolveModelsUrl(baseUrl);
    const options = await fetchModelList(url, api.apiKey.get());
    applyModelOptions(options);
  } catch (err) {
    applyFallbackOptions(err instanceof Error ? err.message : String(err));
  } finally {
    model.optionsLoading.set(false);
  }
}
