import { model, MODEL_OPTIONS_FALLBACK } from './config.js';
import type { ModelOption, ApiModelListResponse } from './config.js';

async function fetchModelList(url: string, apiKey: string): Promise<ModelOption[]> {
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
  if (options.length === 0) {
    model.options.set(MODEL_OPTIONS_FALLBACK);
    model.name.set(MODEL_OPTIONS_FALLBACK[0].name);
    return;
  }
  model.options.set(options);

  const current = model.name.get();
  if (!options.some((opt) => opt.name === current)) {
    model.name.set(options[0].name);
  }
}

export async function updateModelOptions(modelsUrl: string | undefined, apiKey: string): Promise<void> {
  if (!modelsUrl || !apiKey) {
    model.options.set(MODEL_OPTIONS_FALLBACK);
    return;
  }

  model.optionsLoading.set(true);
  model.optionsError.set(null);

  try {
    const options = await fetchModelList(modelsUrl, apiKey);
    applyModelOptions(options);
  } catch (err) {
    model.optionsError.set(err instanceof Error ? err.message : String(err));
    model.options.set(MODEL_OPTIONS_FALLBACK);
  } finally {
    model.optionsLoading.set(false);
  }
}
