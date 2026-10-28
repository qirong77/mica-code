import type { PluginModelProtocol, PluginModelResult, PluginModelsApi } from './PluginModels.js';
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
 * - 页面把 `group: 'llm'` 的字段收进同一个面板，带「跟随主配置」与「测试」；
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
 * 只有一项能力：「这个插件要一个模型接口」。允许跟随主配置的插件（例如 commit 留空就用
 * 当前 provider）把 `followMain` 打开，页面会多一个开关。
 */
export type PluginLlmSpec = {
  /** 面板标题，例如「起标题模型」。缺省用「模型接口」。 */
  label?: string;
  /** 面板说明：这一项在什么时候会被调用、花的是谁的钱。 */
  description?: string;
  /** 允许「跟随主配置」（接口地址 / Key / 协议 / 模型都来自当前 provider）。 */
  followMain?: boolean;
  /** 模型输入框的占位示例。 */
  modelPlaceholder?: string;
  /** 接口地址输入框的占位示例。 */
  baseUrlPlaceholder?: string;
  /** 这一项必须配置（不填就跑不起来）；跟随主配置时自动不算空缺。 */
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
  const followMain = spec.followMain === true;
  const required = spec.required === true;
  // 跟随主配置时，这里填的东西不生效，所以不能因为「留空」报错；
  // 反过来关掉跟随之后它就是必填项（如果插件声明了 required）。
  const requiredWhen = followMain ? { key: 'useMainProvider', equals: 'false' } : undefined;
  const shared = { required, requiredWhen, group: 'llm' as const, perSession: true };

  const fields: PluginSettingField[] = [];
  if (followMain) {
    fields.push({
      key: 'useMainProvider',
      label: '跟随主配置',
      type: 'switch',
      // 不预设 true / false：没表态时按「填了自己的地址就用自己的」推断，见
      // `resolveUseMainProvider`。预设 true 会让已经填过地址的老配置突然改走主配置。
      default: '',
      group: 'llm',
      perSession: true,
      description: '用主配置的接口地址、Key、协议与模型。关掉后单独填下面四项。',
    });
  }
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
export function resolvePluginLlmConfig(
  spec: PluginLlmSpec | null,
  values: Record<string, string | undefined>,
): PluginLlmConfig {
  const useMainProvider = resolveUseMainProvider(spec?.followMain, values);
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
  if (config.useMainProvider) return '跟随主配置';
  if (!config.baseUrl || !config.model) return '未配置';
  return `${config.protocol === 'openai_responses' ? 'Responses' : 'Chat Completions'} · ${config.model}`;
}

/** `ctx.llm.request` 的入参：模型配置由组件填，插件只给提示词与用途。 */
export type PluginLlmRequest = {
  /** 这次请求在 Stats 里叫什么，例如「自动起标题」。 */
  purpose: string;
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
  config(): PluginLlmConfig;
  configured(): boolean;
  /** 人读的一句话，便于健康状态与命令输出。 */
  describe(): string;
  request(request: PluginLlmRequest): Promise<PluginModelResult>;
};

export type CreatePluginLlmApiOptions = {
  spec: PluginLlmSpec;
  /** 全局设置 + 会话覆盖合并后的值；每次调用重新读，改完立刻生效。 */
  readValues: () => Record<string, string | undefined>;
  /** 宿主的请求实现（已按插件 id 绑定，记账挂在插件名下）。 */
  models?: PluginModelsApi['request'];
};

export function createPluginLlmApi(options: CreatePluginLlmApiOptions): PluginLlmApi {
  const readConfig = () => resolvePluginLlmConfig(options.spec, options.readValues());
  return {
    config: readConfig,
    configured: () => isPluginLlmConfigured(readConfig()),
    describe: () => describePluginLlm(readConfig()),
    async request(request) {
      const config = readConfig();
      if (!options.models) throw new Error('宿主没有提供模型请求能力（requires 里缺 models）');
      if (!isPluginLlmConfigured(config)) throw new Error('模型接口未配置：请在插件设置里填写接口地址与模型');
      return options.models({
        purpose: request.purpose,
        system: request.system,
        user: request.user,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        model: request.model?.trim() || config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        protocol: config.protocol,
        useMainProvider: config.useMainProvider,
      });
    },
  };
}
