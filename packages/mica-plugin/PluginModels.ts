/**
 * 插件与「自己发一次模型请求」之间的能力面。
 *
 * 起标题、写 commit message、整理记忆这类后台任务都不属于主对话：它们有自己的接口
 * 地址、Key、协议和模型，也不该把请求内容塞进会话上下文。但它们**是本会话产生的
 * 开销**——插件自己用 fetch 发出去，这笔用量既没有记录口径，也进不了 Stats。
 *
 * 所以请求本身交给宿主：宿主按插件给的地址/协议发一次「system + user → 文本」，
 * 把用量记进会话（`origin: 'plugin'`），插件只负责提示词与结果处理。协议分支、超时、
 * endpoint 拼接因此只有一份实现，插件之间不会再各漂各的。
 *
 * 边界与 `ctx.agent` / `ctx.subagents` 一致：插件拿不到 provider 配置，也改不到
 * 会话用量以外的任何东西。
 */

/** 插件请求支持的协议，与主配置的 `ProviderProtocol` 同义。 */
export type PluginModelProtocol = 'openai_chat_completions' | 'openai_responses';

export type PluginModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
};

export type PluginModelRequest = {
  /**
   * 这次请求在界面上叫什么（Stats 里按它分组/标注），例如「自动起标题」。
   * 同一插件可以有多条用途，各自单独记账。
   */
  purpose: string;
  /** Opaque originating session captured before asynchronous work starts. */
  owner?: unknown;
  /** 系统提示词。 */
  system: string;
  /** 唯一的用户消息正文。 */
  user: string;
  model: string;
  /** OpenAI 兼容的 base URL；写到 `/v1` 即可，端点由宿主按协议补。 */
  baseUrl: string;
  apiKey?: string;
  protocol?: PluginModelProtocol;
  /**
   * 用主配置的接口地址 / Key / 协议发这次请求（`baseUrl` / `apiKey` / `protocol` 被忽略）。
   *
   * `ctx.llm` 在「跟随主配置」时走这条：插件不掌握 provider 配置，由宿主解析。
   */
  useMainProvider?: boolean;
  /** 默认 60s；部分推理模型吐 reasoning 要 5~14s，别设太小。 */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type PluginModelResult = {
  text: string;
  /** 本次请求的用量；宿主拿不到 provider 用量时为 null。 */
  usage: PluginModelUsage | null;
};

export type PluginModelsApi = {
  /**
   * 发一次请求并等结果。
   *
   * 失败以异常形态抛回：要不要重试、要不要降级、要不要上报健康状态都由插件决定。
   * 不会触碰主对话上下文，也不会写进 `usageHistory`（那是主请求的位置）。
   *
   * `ctx.llm` 在这一层之上做的自动降级与它无关：那是「插件配置的模型不可用」这一件事的
   * 统一处理，写在这里的话每个插件都得自己抄一遍，而且拿不到主配置。
   */
  request(request: PluginModelRequest): Promise<PluginModelResult>;
};

/**
 * 宿主实现的请求入口。`PluginManager` 按插件 id 绑定后再交给插件——记账与日志都挂着
 * 插件身份，插件声明不到别人名下。
 */
export type PluginModelsHandler = (
  pluginId: string,
  request: PluginModelRequest,
) => Promise<PluginModelResult>;
