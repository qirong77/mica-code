import type { PluginModelProtocol, PluginModelResult, PluginModelsApi } from './PluginModels.js';
import type { PluginHealthStore } from './PluginHealth.js';
import type { PluginSettingField, PluginSettingOption } from './PluginSettings.js';
import { resolveUseMainProvider } from '@packages/mica-common/index.js';

/**
 * 插件需要自己调模型时的那一份配置。
 *
 * 起标题、写 commit message、整理记忆都属于「后台自己问一次模型」：它们各自有接口地址、
 * Key、协议和模型，插件里不该把这件事再抄一遍。所以配置只有一个来源——清单里的 `llm`
 * 声明，字段（`baseUrl` / `apiKey` / `protocol` / `model`）由这里统一生成：
 *
 * - 存储、校验、按会话覆盖仍然走 `settings` 那一套，不新增第二种读写；
 * - 页面把 `group: 'llm'` 的字段收进同一个面板，带「复用当前会话模型」与「测试」；
 * - 插件通过 `ctx.llm.config()` / `ctx.llm.request()` 拿到解析好的配置，不用自己拼。
 */

/** 协议选项与主配置一致；插件不参与 effort，也不声明自定义协议。 */
export const PLUGIN_LLM_PROTOCOLS: PluginSettingOption[] = [
  { value: 'openai_chat_completions', label: 'Chat Completions' },
  { value: 'openai_responses', label: 'Responses' },
];

export const DEFAULT_PLUGIN_LLM_PROTOCOL: PluginModelProtocol = 'openai_chat_completions';

/**
 * 清单里的 `llm` 声明。
 *
 * 只有一项能力：「这个插件要一个模型接口」。所有声明的插件都自带两条路——自己填
 * 接口地址 / Key / 协议 / 模型，或勾上「复用当前会话模型」；后者还是前者的兜底。
 * 插件作者不需要（也不能）逐个开关这个能力。
 */
export type PluginLlmSpec = {
  /** 面板标题，例如「起标题模型」。缺省用「模型接口」。 */
  label?: string;
  /** 面板说明：这一项在什么时候会被调用、花的是谁的钱。 */
  description?: string;
  /**
   * 开关的初始状态：缺省**复用当前会话模型**——插件声明了 `llm` 就是「我要问模型」，
   * 而会话里已经有一个用户付钱、也认得上下文的模型，没有再让每个人各填一套地址的理由。
   *
   * 只影响「用户还没拨过」时的取值。少数必须用独立接口才好用的插件（换更便宜的模型、
   * 另一家服务）可以写 `false`，让面板一开始就摊开那四项。
   */
  reuseByDefault?: boolean;
  /** 模型输入框的占位示例。 */
  modelPlaceholder?: string;
  /** 接口地址输入框的占位示例。 */
  baseUrlPlaceholder?: string;
  /** 这一项必须配置（不填就跑不起来）；复用会话模型时自动不算空缺。 */
  required?: boolean;
};

export type PluginLlmConfig = {
  /** 用主配置的接口地址 / Key / 协议 / 模型。 */
  useMainProvider: boolean;
  baseUrl: string;
  apiKey: string;
  protocol: PluginModelProtocol;
  model: string;
};

/** 这些键由 `llm` 声明生成，不允许再在 `settings` 里重复声明。 */
export const PLUGIN_LLM_SETTING_KEYS = ['useMainProvider', 'baseUrl', 'apiKey', 'protocol', 'model'] as const;

export function isPluginLlmSettingKey(key: string): boolean {
  return (PLUGIN_LLM_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * 把 `llm` 声明展开成普通设置字段。
 *
 * 展开而不是另建一套存储：校验、按会话覆盖、配置页表单因此都只有一条路径，插件作者
 * 也只写一次声明。字段顺序就是面板里的顺序。
 */
export function pluginLlmSettingFields(spec: PluginLlmSpec): PluginSettingField[] {
  const required = spec.required === true;
  // 复用会话模型时，下面几项不生效，所以不能因为「留空」报错；
  // 反过来关掉复用之后它就是必填项（如果插件声明了 required）。
  const requiredWhen = { key: 'useMainProvider', equals: 'false' };
  const shared = { required, requiredWhen, group: 'llm' as const, perSession: true };

  const fields: PluginSettingField[] = [
    {
      key: 'useMainProvider',
      label: '复用当前会话模型',
      type: 'switch',
      // 取插件声明的开箱行为；用户拨过之后就以存下来的值为准。
      default: spec.reuseByDefault === false ? 'false' : 'true',
      group: 'llm',
      perSession: true,
      description:
        '直接使用当前会话正在用的接口、Key、协议与模型；请求失败时也会自动降级到这里。关掉后单独填下面四项。',
    },
  ];
  fields.push(
    {
      key: 'baseUrl',
      label: '接口地址',
      type: 'text',
      format: 'url',
      placeholder: spec.baseUrlPlaceholder ?? 'https://api.openai.com/v1',
      description: '写到 /v1 即可，按协议补 /chat/completions 或 /responses。',
      ...shared,
    },
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      description: '只写在本机的插件设置文件里，不会进入会话记录。可以填 ${MY_KEY} 从环境变量读。',
      ...shared,
      required: false,
      requiredWhen: undefined,
    },
    {
      key: 'protocol',
      label: '协议',
      type: 'select',
      default: DEFAULT_PLUGIN_LLM_PROTOCOL,
      options: PLUGIN_LLM_PROTOCOLS,
      ...shared,
      required: false,
      requiredWhen: undefined,
    },
    {
      key: 'model',
      label: '模型',
      type: 'text',
      placeholder: spec.modelPlaceholder ?? 'gpt-4.1-mini',
      description: '后台任务用的小模型通常就够。',
      ...shared,
    },
  );
  return fields;
}

/** 解析后的配置：设置文件里的字符串 → 运行期可直接用的四个字段。 */
export function resolvePluginLlmConfig(values: Record<string, string | undefined>): PluginLlmConfig {
  const useMainProvider = resolveUseMainProvider(values);
  const protocol = values.protocol;
  return {
    useMainProvider,
    baseUrl: (values.baseUrl ?? '').trim(),
    // Key 支持 `${ENV_VAR}`：设置文件是明文 JSON，长期凭据更适合放在环境变量里。
    // 只对 Key 展开——地址走 url 校验，占位符会被判成非法值。
    apiKey: expandEnvPlaceholders((values.apiKey ?? '').trim()),
    protocol: PLUGIN_LLM_PROTOCOLS.some((option) => option.value === protocol)
      ? (protocol as PluginModelProtocol)
      : DEFAULT_PLUGIN_LLM_PROTOCOL,
    model: (values.model ?? '').trim(),
  };
}

/** 缺少配置时插件应当上报「待配置」，而不是发一次注定失败的请求。 */
export function isPluginLlmConfigured(config: PluginLlmConfig): boolean {
  if (config.useMainProvider) return true;
  return Boolean(config.baseUrl && config.model);
}

/** `${VAR}` → 环境变量；变量缺失时变成空串，由 `isPluginLlmConfigured` 判为未配置。 */
export function expandEnvPlaceholders(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? '');
}

/** 人读的一句话，用于健康状态与 `/commit` 这类输出（不打印 Key）。 */
export function describePluginLlm(config: PluginLlmConfig): string {
  if (config.useMainProvider) return '复用当前会话模型';
  if (!config.baseUrl || !config.model) return '未配置';
  return `${config.protocol === 'openai_responses' ? 'Responses' : 'Chat Completions'} · ${config.model}`;
}

/**
 * 面板需要的展示状态：模型配置组件（配置页与会话设置共用）只认这一份数据。
 *
 * `main` 是「复用当前会话模型」实际会用的那一个：配置页给全局 provider，会话设置给
 * 当前会话的模型。调用方各自拼这句人读摘要——两个宿主知道的 provider 信息不同，
 * 但「跟随 / 独立」的判定与是否可用必须同源，否则页面会显示一个不会发出去的值。
 */
export type PluginLlmMainInfo = {
  /** 例如「复用当前会话 · Chat Completions · gpt-5」。 */
  summary: string;
  available: boolean;
};

export type PluginLlmView = {
  label: string;
  description: string;
  /** 生效配置的人读摘要（不含 Key）。 */
  summary: string;
  configured: boolean;
  /** 不复用会话模型时这几项必填，页面据此加标记。 */
  required: boolean;
};

export function describePluginLlmView(
  spec: PluginLlmSpec,
  values: Record<string, string | undefined>,
  main?: PluginLlmMainInfo,
): PluginLlmView {
  const config = resolvePluginLlmConfig(values);
  const view = {
    label: spec.label ?? '模型接口',
    description: spec.description ?? '这个插件会用它自己问一次模型。',
    required: spec.required === true,
  };
  if (!config.useMainProvider) {
    return { ...view, summary: describePluginLlm(config), configured: isPluginLlmConfigured(config) };
  }
  const available = main?.available === true;
  return {
    ...view,
    summary: main?.summary ?? '当前会话没有可用的模型',
    configured: available,
  };
}

/** `ctx.llm.request` 的入参：模型配置由组件填，插件只给提示词与用途。 */
export type PluginLlmRequest = {
  /** 这次请求在 Stats 里叫什么，例如「自动起标题」。 */
  purpose: string;
  owner?: unknown;
  system: string;
  user: string;
  /** 覆盖模型（同一插件里某一次想换小模型）；不填用配置里的。 */
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * 插件侧的模型入口：配置与请求合成一件事。
 *
 * 三个插件（起标题 / 提交说明 / 记忆整理）原先各自把 `baseUrl + apiKey + protocol +
 * model` 拼进 `ctx.models.request`，每处都要记得补齐四项、记得判断「没配就别发」。
 * 现在它们只声明 `llm`，读 `ctx.llm.config()`、发 `ctx.llm.request()`：
 *
 * - 记账仍走 `ctx.models`，Stats 里照样能看到这笔开销；
 * - 「跟随主配置」由宿主解析成真实地址，插件不需要认识 provider；
 * - 没配置时 `request` 直接抛错，调用方按「待配置」上报，不会发一次注定失败的请求。
 */
export type PluginLlmApi = {
  /** 当前生效的配置（全局设置 + 本会话覆盖）。 */
  config(owner?: unknown): PluginLlmConfig;
  configured(owner?: unknown): boolean;
  /** 人读的一句话，便于健康状态与命令输出；已降级到主配置时会标出来。 */
  describe(owner?: unknown): string;
  request(request: PluginLlmRequest): Promise<PluginModelResult>;
};

export type CreatePluginLlmApiOptions = {
  spec: PluginLlmSpec;
  /** 全局设置 + 会话覆盖合并后的值；每次调用重新读，改完立刻生效。 */
  readValues: (owner?: unknown) => Record<string, string | undefined>;
  /** 宿主的请求实现（已按插件 id 绑定，记账挂在插件名下）。 */
  models?: PluginModelsApi['request'];
  /**
   * 降级时上报一次：配置的接口/模型坏了是用户可见的故障，不能只留在日志里。
   * 不传就不上报（测试与没有健康通道的宿主）。
   */
  health?: Pick<PluginHealthStore, 'report'>;
};

export function createPluginLlmApi(options: CreatePluginLlmApiOptions): PluginLlmApi {
  const readConfig = (owner?: unknown) => resolvePluginLlmConfig(options.readValues(owner));
  // 配置的接口/模型不可用时降级为主配置。记住「这一份配置已经失败过」：之后的请求直接
  // 走降级，不再先白白失败一次；用户改过任何一项（指纹变化）就重新尝试自己的配置。
  let degradedFingerprint: string | null = null;
  let reportedFingerprint: string | null = null;

  const send = (request: PluginLlmRequest, config: PluginLlmConfig, degraded: boolean) => {
    const models = options.models;
    if (!models) throw new Error('宿主没有提供模型请求能力（requires 里缺 models）');
    // 「跟随主配置」与「降级」都要宿主解析地址：插件不掌握 provider 配置。
    const useMainProvider = degraded || config.useMainProvider;
    return models({
      purpose: request.purpose,
      ...(request.owner === undefined ? {} : { owner: request.owner }),
      system: request.system,
      user: request.user,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      // 降级时把模型名也清空：让宿主用主配置当前的模型，而不是继续索要那个
      // 在别处并不存在的名字。
      model: degraded ? '' : request.model?.trim() || (useMainProvider ? '' : config.model),
      baseUrl: useMainProvider ? '' : config.baseUrl,
      apiKey: useMainProvider ? '' : config.apiKey,
      protocol: useMainProvider ? undefined : config.protocol,
      useMainProvider,
    });
  };

  return {
    config: readConfig,
    configured: (owner) => isPluginLlmConfigured(readConfig(owner)),
    describe: (owner) => {
      const config = readConfig(owner);
      const text = describePluginLlm(config);
      // 跟随主配置时也可能降级（点名的模型在主配置下不存在），所以这里不写「为主配置」。
      return degradedFingerprint === pluginLlmFingerprint(config) ? `${text}（已降级）` : text;
    },
    async request(request) {
      const config = readConfig(request.owner);
      if (!options.models) throw new Error('宿主没有提供模型请求能力（requires 里缺 models）');
      if (!isPluginLlmConfigured(config)) throw new Error('模型接口未配置：请在插件设置里填写接口地址与模型');
      const fingerprint = pluginLlmFingerprint(config);
      if (degradedFingerprint === fingerprint) return send(request, config, true);

      try {
        return await send(request, config, false);
      } catch (error) {
        // 已经是最稳的目标（跟随主配置且没点名模型）或用户主动中断时，重发没有意义。
        if (!canFallback(request, config, error)) throw error;
        let result: PluginModelResult;
        try {
          result = await send(request, config, true);
        } catch (fallbackError) {
          throw withFallbackFailure(error, fallbackError);
        }
        // 只有降级确实成功了才记住：两边都失败多半是网络问题，下次仍先试用户自己的配置。
        degradedFingerprint = fingerprint;
        if (reportedFingerprint !== fingerprint) {
          reportedFingerprint = fingerprint;
          options.health?.report({
            level: 'warn',
            message: `配置的模型不可用，已降级为主配置：${errorMessage(error)}`,
            hint: '到插件设置里检查接口地址、Key 与模型名；改动后会自动重新尝试。',
          });
        }
        return result;
      }
    },
  };
}

/** 一份插件模型配置的身份：用户改过任何一项就重新尝试自己的接口。 */
function pluginLlmFingerprint(config: PluginLlmConfig): string {
  return JSON.stringify([config.useMainProvider, config.baseUrl, config.apiKey, config.protocol, config.model]);
}

/**
 * 还有没有第二个目标可试。
 *
 * 已经跟随主配置、又没有点名模型时，「降级」只是把同一个目标再发一次；用户主动中断
 * （关页面、按停止）时也不能悄悄再发一次请求。
 */
function canFallback(request: PluginLlmRequest, config: PluginLlmConfig, error: unknown): boolean {
  if (request.signal?.aborted) return false;
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  if (name === 'AbortError') return false;
  if (!config.useMainProvider) return true;
  return Boolean(request.model?.trim());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 降级也没成功时抛原始错误（信息量更大），把降级失败的原因附在后面。 */
function withFallbackFailure(primary: unknown, fallback: unknown): Error {
  const error = primary instanceof Error ? primary : new Error(errorMessage(primary));
  error.message = `${error.message}；降级为主配置也失败：${errorMessage(fallback)}`;
  return error;
}
