import { resolveMicaHomePath } from './brand.js';

/**
 * 我们认得名字的档位，只用于排序与界面文案。
 *
 * **可选档位不来自这里，而来自模型规则**：各厂商的档位集合并不相同（`minimal`、
 * `max`、`on` …），把它们折算成统一的五档等于替模型编造别名——`max` 被发成
 * `xhigh` 会被拒绝，`minimal` 被折成 `low` 则根本不是用户选的那一档。
 */
export const KNOWN_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max', 'on'] as const;
export const PROVIDER_PROTOCOLS = ['openai_chat_completions', 'openai_responses'] as const;
export const DEFAULT_MODEL_CONTEXT_SIZE = 256;
export const CONFIG_PATH = resolveMicaHomePath('config.json');

export type KnownEffortLevel = (typeof KNOWN_EFFORT_LEVELS)[number];
/** 模型声明的档位名；已知名字有提示，其余厂商自定义的名字同样合法。 */
export type EffortOption = KnownEffortLevel | (string & {});
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];
export type ModelRequestPatch = Record<string, unknown>;
export type ModelEffortRule = Partial<Record<ProviderProtocol, ModelRequestPatch>>;

export interface ProviderDefinition {
  id: string;
  api_base: string;
  api_key?: string;
  protocol: ProviderProtocol;
  models?: string[];
  supportsEffort?: boolean;
  /**
   * 该服务端真实接受的档位名，按从弱到强排列。
   *
   * 只用于 models.dev 没有收录的模型（自建网关、私有部署）：有元数据时一律以模型自己的
   * 档位为准，这里不参与。填进来的名字会原样作为 `reasoning_effort` / `reasoning.effort`
   * 发出，所以必须写服务端认的取值，而不是我们习惯的叫法。
   */
  effortLevels?: EffortOption[];
  get_model_url?: string;
}

export interface PersistedMicaConfig {
  providers: ProviderDefinition[];
  /**
   * Default capability selection copied into new sessions. Existing sessions keep
   * their own snapshot, so changing this never rewrites an open conversation.
   */
  capabilityDefaults?: {
    disabledSkills?: string[];
    disabledTools?: string[];
    disabledMcpServers?: string[];
  };
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
  /** Whether the model accepts image input. Missing/true means vision-capable. */
  supportsVision?: boolean;
  defaultEffort: EffortOption;
  /**
   * 该模型真实可选的档位：键就是模型/厂商自己使用的档位名，每档带各协议自己的
   * 请求参数补丁。空对象表示没有可用的 effort 控制（非推理模型，或元数据没说明
   * 怎么控制它）——此时任何档位都不发送参数，也不替它猜。
   */
  efforts: Partial<Record<EffortOption, ModelEffortRule>>;
};

export type ResolvedEffortParams = Record<string, unknown>;

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

/**
 * 档位名的语法校验。
 *
 * 具体某档是否可用由模型规则决定（见 `normalizeModelEffort`），这里只挡明显不是
 * 档位名的东西（空串、带空格、超长），因为可选集合随模型变化，没有全局枚举。
 */
export function isEffortLevelName(value: unknown): value is EffortOption {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return PROVIDER_PROTOCOLS.includes(value as ProviderProtocol);
}

export function providerSupportsModel(provider: ProviderDefinition, model: string): boolean {
  if (!Array.isArray(provider.models) || provider.models.length === 0) return true;
  return provider.models.includes(model);
}

/**
 * 这个模型实际由哪个 provider 服务：带 `provider/model` 前缀时按最长前缀匹配，
 * 否则算在当前 provider 上（常驻会话里的裸模型名就是这种）。
 *
 * 档位、上下文窗口这类元数据都跟着「谁在服务」走：同一个模型名挂在网关上时
 * 可选档位可能与厂商自己的条目不同，所以要先把归属解出来再查。
 */
export function providerForModel(
  config: Pick<IMicaConfig, 'providers' | 'provider'>,
  model: string | undefined,
): ProviderDefinition | undefined {
  if (model) {
    const matched = [...config.providers]
      .sort((left, right) => right.id.length - left.id.length)
      .find((provider) => model.startsWith(`${provider.id}/`));
    if (matched) return matched;
  }
  return config.providers.find((provider) => provider.id === config.provider);
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
