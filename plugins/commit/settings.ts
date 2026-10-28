import { micaConfig, type ProviderProtocol } from '@packages/mica-config/index.js';
import type { PluginSettingValues } from '@packages/mica-plugin/index.js';
import { DEFAULT_PROMPT, type MessageRequestConfig } from './message.js';

/**
 * 插件设置 → 一次 commit message 请求要用的参数。
 *
 * 两条路，靠「接口地址填没填」区分，不额外加一个模式开关：
 *
 * - 留空：跟随主配置。provider 由模型名反查（`micaConfig.providerForModel`），
 *   地址、Key、协议都取它；模型留空用主配置当前的模型，填了就换模型、仍走同一个接口。
 * - 填了：独立接口。地址、协议、模型都用插件自己的设置，Key 留空就发空 Key
 *   （本地网关常常不校验）。
 *
 * 这样「只是想把 commit message 换成便宜模型」只改一个模型名，
 * 「想彻底用另一家」才需要填地址。
 */

export type CommitSettings = {
  baseUrl: string;
  apiKey: string;
  protocol: ProviderProtocol;
  model: string;
  prompt: string;
  push: boolean;
};

export type ResolvedMessageTarget = {
  config: MessageRequestConfig;
  /** 地址来自插件设置（独立接口）而不是主配置。 */
  standalone: boolean;
  /** 独立接口配置不全时的原因；有值时不要发请求。 */
  problem?: string;
};

export function readCommitSettings(values: PluginSettingValues): CommitSettings {
  return {
    baseUrl: (values.baseUrl ?? '').trim(),
    apiKey: (values.apiKey ?? '').trim(),
    protocol: parseProtocol(values.protocol),
    model: (values.model ?? '').trim(),
    prompt: (values.prompt ?? '').trim() || DEFAULT_PROMPT,
    push: (values.push ?? 'true') !== 'false',
  };
}

export function resolveMessageTarget(settings: CommitSettings): ResolvedMessageTarget {
  if (settings.baseUrl) {
    const config: MessageRequestConfig = {
      baseUrl: settings.baseUrl,
      apiKey: resolveSecret(settings.apiKey),
      protocol: settings.protocol,
      model: settings.model,
      prompt: settings.prompt,
    };
    return {
      config,
      standalone: true,
      problem: settings.model ? undefined : '填了接口地址但没填模型，commit message 无法生成',
    };
  }

  const config = micaConfig.get();
  const model = settings.model || config.model;
  if (!model) {
    return {
      config: { baseUrl: '', apiKey: '', protocol: settings.protocol, model: '', prompt: settings.prompt },
      standalone: false,
      problem: '主配置没有可用模型，请在插件设置里填模型或接口地址',
    };
  }
  const provider = micaConfig.providerForModel(model) ?? config.providers[0];
  if (!provider) {
    return {
      config: { baseUrl: '', apiKey: '', protocol: settings.protocol, model, prompt: settings.prompt },
      standalone: false,
      problem: '主配置没有可用 provider，请在插件设置里填接口地址',
    };
  }

  return {
    config: {
      baseUrl: provider.api_base,
      apiKey: resolveSecret(provider.api_key ?? ''),
      protocol: provider.protocol,
      model,
      prompt: settings.prompt,
    },
    standalone: false,
  };
}

function parseProtocol(value: string | undefined): ProviderProtocol {
  return value === 'openai_responses' ? 'openai_responses' : 'openai_chat_completions';
}

/** `${VAR}` / `${VAR:-默认值}`：长期凭据不必写进设置文件。 */
function resolveSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/.exec(trimmed);
  if (!match) return trimmed;
  const [, name, fallback] = match;
  const fromEnv = process.env[name!];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : (fallback ?? '');
}
