import { model } from './config.js';
import type { ModelOption, ApiModelListResponse } from './config.js';

export interface UpdateModelOptionsResult {
  error: string | null;
  options: ModelOption[];
}

async function fetchModelList(url: string, apiKey: string, authType: 'bearer' | 'x-api-key' = 'bearer'): Promise<ModelOption[]> {
  const headers: Record<string, string> =
    authType === 'x-api-key'
      ? { 'x-api-key': apiKey }
      : { Authorization: `Bearer ${apiKey}` };

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = (await res.json()) as ApiModelListResponse;
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error('invalid response format');
  }
  return json.data.filter((m) => m.id).map((m) => ({ name: m.id, label: m.id }));
}

function applyModelOptions(options: ModelOption[]): void {
  if (options.length === 0) {
    model.options.set([]);
    return;
  }
  model.options.set(options);

  const current = model.name.get();
  if (!options.some((opt) => opt.name === current)) {
    model.name.set(options[0].name);
  }
}

function setModelOptionsError(message: string): UpdateModelOptionsResult {
  model.optionsError.set(message);
  model.options.set([]);
  return { error: message, options: [] };
}

export async function updateModelOptions(
  modelsUrl: string | undefined,
  apiKey: string,
  authType: 'bearer' | 'x-api-key' = 'bearer',
  customModels?: ModelOption[],
): Promise<UpdateModelOptionsResult> {
  if (customModels && customModels.length > 0) {
    applyModelOptions(customModels);
    return { error: null, options: customModels };
  }

  if (!modelsUrl) {
    model.optionsLoading.set(false);
    return setModelOptionsError('当前 provider 未配置 models_url');
  }

  if (!apiKey) {
    model.optionsLoading.set(false);
    return setModelOptionsError(
      '当前 provider 未配置 API Key，请在 ~/.mica/config.json 的 providers 中设置 api_key，或配置对应环境变量',
    );
  }

  model.optionsLoading.set(true);
  model.optionsError.set(null);

  try {
    const options = await fetchModelList(modelsUrl, apiKey, authType);
    if (options.length === 0) {
      return setModelOptionsError('当前 provider 返回了空模型列表');
    }
    applyModelOptions(options);
    return { error: null, options };
  } catch (err) {
    return setModelOptionsError(
      `获取模型列表失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    model.optionsLoading.set(false);
  }
}
