import {
  isEffortLevelName,
  micaConfig,
  normalizeModelEffort,
  type EffortOption,
  type IMicaConfig,
  type ProviderDefinition,
} from '@packages/mica-config/index.js';
import type { AgentRuntimeConfigOverride } from '../agent/AgentRuntimeConfig.js';

/**
 * 档位对不上时怎么处理：
 *
 * - `strict`：命令行里显式写的 `--variant`（`mica exec`）。用户可能打错字，静默换成
 *   别的档位会让人以为设置生效了，所以直接报错并列出可用档位。
 * - `clamp`：客户端（desktop 的模型/强度选择器、Codex 驱动）带上来的选择。这类值可能
 *   来自上一次会话、另一个模型，不该让它把 host 拦下来（那会变成一条永远发不出去的
 *   消息），所以收敛到目标模型自己的档位，并把调整原因回给调用方提示用户。
 */
export type EffortPolicy = 'strict' | 'clamp';

export type EffortAdjustment = {
  /** 请求里写的那一档。 */
  requested: string;
  /** 实际会记进会话/发出去的档位；缺省表示这次请求不带推理参数。 */
  applied?: EffortOption;
  /** unknown-level：不是档位名；undeclared：模型没有声明任何档位；unsupported：模型没这一档。 */
  reason: 'unknown-level' | 'undeclared' | 'unsupported';
};

export type ResolvedRuntimeOverride = AgentRuntimeConfigOverride & {
  /** clamp 策略下被丢掉或改写的档位，调用方据此提示用户实际发出去的是什么。 */
  effortAdjustment?: EffortAdjustment;
};

export async function listRuntimeModelIds(): Promise<string[]> {
  const initial = micaConfig.get();
  await Promise.all(
    initial.providers.map(async (provider) => {
      if (!provider.get_model_url || provider.models?.length) return;
      try {
        await micaConfig.loadProviderModels(provider.id);
      } catch {
        // Dynamic discovery is best-effort. Multica supports manual model entry
        // when a runtime reports an empty or partial catalog.
      }
    }),
  );

  const config = micaConfig.get();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const provider of config.providers) {
    const models = [...(provider.models ?? [])];
    if (provider.id === config.provider && config.model && !models.includes(config.model)) {
      models.push(config.model);
    }
    for (const model of models) {
      const id = `${provider.id}/${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function resolveRuntimeConfigOverride(
  config: IMicaConfig,
  modelID?: string,
  variant?: string,
  options: { effortPolicy?: EffortPolicy; fallbackProviderId?: string } = {},
): ResolvedRuntimeOverride {
  const matchedProvider = [...config.providers]
    .sort((left, right) => right.id.length - left.id.length)
    .find((provider) => modelID?.startsWith(`${provider.id}/`));
  const model = !modelID ? config.model : matchedProvider ? modelID.slice(matchedProvider.id.length + 1) : modelID;
  if (modelID && matchedProvider && !model) {
    throw new Error(`Missing model name after provider prefix: ${modelID}`);
  }
  // 没有 provider 前缀的 model（常驻 host 里的会话模型）属于「当前正在跑的 provider」，
  // 不是全局默认 provider：档位要按正在生效的协议过滤，否则两种协议同一模型会算出两套档位。
  const provider =
    matchedProvider ?? config.providers.find((item) => item.id === (options.fallbackProviderId ?? config.provider));
  const { effort, adjustment } = resolveEffort(variant, model, provider, options.effortPolicy ?? 'clamp');
  const extra = adjustment ? { effortAdjustment: adjustment } : {};

  if (!modelID) return effort ? { effort, ...extra } : { ...extra };
  if (!matchedProvider) {
    return {
      model: modelID,
      ...(effort ? { effort } : {}),
      ...extra,
    };
  }
  return {
    providerId: matchedProvider.id,
    model,
    ...(effort ? { effort } : {}),
    ...extra,
  };
}

function resolveEffort(
  variant: string | undefined,
  model: string | undefined,
  provider: ProviderDefinition | undefined,
  policy: EffortPolicy,
): { effort?: EffortOption; adjustment?: EffortAdjustment } {
  if (!variant) return {};
  // 档位名由模型自己声明（`max`、`minimal` …），不换算也不落别名；这里只挡不是档位名的输入。
  const knownName = isEffortLevelName(variant);
  if (!knownName && policy === 'strict') {
    throw new Error(`Unsupported --variant value: ${variant}. Use one of the levels that model declares.`);
  }
  if (!model) return knownName ? { effort: variant } : {};
  // 档位集合必须来自已加载的模型元数据：调用方负责在此之前 ensureModelRule，
  // 否则「只在磁盘缓存里、随包种子里没有」的模型会被误判成没有档位。
  const levels = micaConfig.getModelEffortOptions(model, provider?.protocol, provider);
  if (policy === 'strict') {
    if (levels.length === 0) {
      throw new Error(
        `Model ${model} exposes no reasoning effort levels; add providers[].effortLevels if the endpoint accepts them.`,
      );
    }
    if (!levels.includes(variant)) {
      throw new Error(`Unsupported --variant ${variant} for ${model}; available levels: ${levels.join(', ')}.`);
    }
    return { effort: variant };
  }
  // clamp：模型不认识这次要的档位就收敛到它自己的档位，并带回调整原因。
  if (!knownName) return { adjustment: { requested: variant, reason: 'unknown-level' } };
  if (levels.length === 0) {
    // 完全没有元数据 ≠ 模型不接受档位：我们只是「不知道」，所以保留原值不抹掉用户存的
    // 档位（`normalizeModelEffort` 同一约定），只是这次请求不会带推理参数。
    return { effort: variant, adjustment: { requested: variant, applied: variant, reason: 'undeclared' } };
  }
  if (!levels.includes(variant)) {
    const applied = normalizeModelEffort(model, variant, provider);
    return { effort: applied, adjustment: { requested: variant, applied, reason: 'unsupported' } };
  }
  return { effort: variant };
}
