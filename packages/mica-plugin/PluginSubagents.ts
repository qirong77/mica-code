import type { Disposable } from '@packages/mica-common/index.js';

/**
 * 插件与「委派一个子代理」之间的能力面。
 *
 * 内核负责机制：建子代理、跑它、记用量、管后台任务、锁路径、完成后回注通知。
 * 插件负责策略：有哪些子代理类型、`agent` 工具长什么样、什么情况下该委派——
 * 这些本来就不该写死在核心里（否则换一套委派策略就得改内核）。
 *
 * 边界与 `ctx.agent` 一致：插件拿不到 `AgentRuntime`，也没有 provider 配置。
 * `spawn` 的入参只描述「要什么」，具体怎么建由宿主决定。
 */

/** 交给子代理多少父会话上下文。 */
export type PluginSubagentContextMode = 'none' | 'brief' | 'recent' | 'files';

/**
 * 子代理的写入策略，由宿主在执行期强制（写工具读 `toolContext` 判定）。
 * - `none`：不给写工具，也不允许跑会改文件的命令
 * - `owned_paths`：只允许写 `ownedPaths` 之内的路径
 * - `proposal`：不落盘，只返回 patch 供父代理应用
 * - `unrestricted`：与父代理一致
 */
export type PluginSubagentWriteMode = 'none' | 'owned_paths' | 'proposal' | 'unrestricted';

/**
 * 一种可被 spawn 的子代理类型。
 *
 * 注册在插件名下：插件卸载时这些类型随之消失，别的插件注册不到别人的名下。
 */
export type PluginSubagentType = {
  name: string;
  description: string;
  systemPrompt: string;
  /** Maintenance stays out of the delegated-task dock; its usage remains recorded. */
  activity?: 'delegation' | 'maintenance';
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  /** 父代理是否可以指定 reasoning effort。默认 true；false 时强制 `none`。 */
  effort?: boolean;
  /** 父代理省略 `contextMode` 时的默认值。 */
  contextModeDefault?: PluginSubagentContextMode;
  writeMode?: PluginSubagentWriteMode;
  /** 为 true 时父代理必须给出非空 `ownedPaths`。 */
  requireOwnedPaths?: boolean;
};

export type PluginSubagentTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export type PluginSubagentTaskSnapshot = {
  id: string;
  type: string;
  description: string;
  status: PluginSubagentTaskStatus;
  model: string;
  effort: string;
  startedAt: string;
  finishedAt?: string;
  parentTaskId?: string;
  initiatedByCallId?: string;
  /** 子代理的最终输出；还在跑时为 undefined。 */
  result?: string;
  error?: string;
  activities?: { id: string; summary: string }[];
  timeline?: { kind: string; text: string; createdAt?: string }[];
};

/**
 * 这次委派从哪儿发起。`caller(context)` 从工具执行回调里解出来，插件原样传回 `spawn`。
 *
 * `owner` 是内核的不透明句柄：插件不解释它，只负责带回去——宿主据此决定在哪个 agent
 * 下建子代理、任务归谁。多 agent 会话下这决定了子代理挂在正确的会话上。
 */
export type PluginSubagentCaller = {
  readonly owner?: unknown;
  /** 当前调用本身就跑在某个子代理里时，那个子代理的后台任务 id。 */
  taskId?: string;
  /** 父代理这次工具调用的 id，用于把用量记到具体调用上。 */
  toolCallId?: string;
};

export type PluginSubagentSpawnRequest = {
  /** 已注册的类型名；不传用第一个注册的类型。 */
  type?: string;
  description: string;
  /** 委派正文。父会话上下文由宿主按 `contextMode` 补上，插件不需要自己拼。 */
  prompt: string;
  contextMode?: PluginSubagentContextMode;
  contextFiles?: string[];
  ownedPaths?: string[];
  effort?: string;
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  caller?: PluginSubagentCaller;
};

export type PluginSubagentRunResult = {
  taskId: string;
  status: 'completed' | 'partial' | 'failed' | 'killed';
  /** 子代理的原始最终输出；失败时可能为空。 */
  output: string;
  error?: string;
};

export type PluginSubagentTaskHandle = {
  taskId: string;
  /** 后台任务结束（成功、失败或被杀）时结算，不抛错。 */
  done: Promise<PluginSubagentRunResult>;
};

export type PluginSubagentAwaitOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * 一条可复用的隔离子代理线程（旁问线程）的构造参数。
 *
 * 与 `run` / `background` 的差别：那些是「派一次任务」，每次都是新的子代理；线程
 * 是**同一个子代理连续追问**，它的消息数组就是这条线程的上下文，所以第二次问能
 * 看到第一次读过什么。系统提示词由插件整体提供（替换主 prompt），因为线程要回答
 * 什么不该由内核猜。
 */
export type PluginSubagentThreadOptions = {
  /** 记账用的类型名；Stats 的「By plugin」按它分组。 */
  type: string;
  /** 系统提示词：整体替换主流程的 prompt，不叠加。 */
  systemPrompt: string;
  /** 记账用的默认描述；每次提问可以覆盖。 */
  description?: string;
  /** 是否给工具，默认给。主会话专属工具（`primaryAgentOnly`）始终不给。 */
  tools?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  /** 每个问题的最大模型请求数；不传不限。 */
  maxTurns?: number;
};

/**
 * 问一次线程。
 *
 * 流式回调是可选的：挂上就是主对话那套实时渲染（正文 / 思考 / 工具行），不挂就是
 * 「问一句、等最终文本」。终端里的旁问只有一条 notice，没有实时渲染的空间，所以
 * 不挂不是降级，而是那一边本来就不需要。
 */
export type PluginSubagentThreadAskOptions = {
  signal?: AbortSignal;
  description?: string;
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall?: (name: string, args: string, id?: string) => void;
  onToolResult?: (name: string, result: string, id?: string) => void;
};

export type PluginSubagentThreadUsage = {
  /** 这条线程已经发出过多少次模型请求。 */
  requests: number;
  last: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
};

export type PluginSubagentThread = {
  /**
   * 问一个问题；线程自己的历史会保留，下一次问接着上一轮。
   *
   * 失败以异常抛回：线程被中止、模型报错都算。宿主在返回前已经把这一问产生的用量
   * 记进会话（`origin: 'plugin'`），插件不需要自己记账。
   */
  ask(question: string, options?: PluginSubagentThreadAskOptions): Promise<string>;
  usage(): PluginSubagentThreadUsage;
  /** 丢掉线程与它的上下文；之后再问必须重新 `thread()`。 */
  dispose(): void;
};

export type PluginSubagentApi = {
  /** 注册一种类型；重复名字报错。返回的 disposable 只摘掉这一条。 */
  registerType(type: PluginSubagentType): Disposable;
  listTypes(): PluginSubagentType[];
  getType(name: string | undefined): PluginSubagentType | null;
  /** 前台跑：等子代理结束再返回。父代理被中止时以 `killed` 结算。 */
  run(request: PluginSubagentSpawnRequest): Promise<PluginSubagentRunResult>;
  /**
   * 后台跑：立刻返回 taskId，完成后宿主把结果回注给父会话。
   *
   * 插件不需要轮询——但也不该假设通知一定到达（headless 宿主没有回注通道），
   * 需要结果时用 `tasks.wait`。
   */
  background(request: PluginSubagentSpawnRequest): PluginSubagentTaskHandle;
  tasks: {
    /**
     * 本插件起过的后台任务。
     *
     * 传 `owner`（也就是 `caller().owner`）只看那个 agent 名下的任务——一个进程里可能
     * 同时开着多条终端会话，把别的会话的子代理列进当前会话是错的。
     */
    list(owner?: unknown): PluginSubagentTaskSnapshot[];
    get(taskId: string): PluginSubagentTaskSnapshot | null;
    /** 返回 false 表示任务不存在或已经结束。 */
    kill(taskId: string): boolean;
    /** 等到这些任务全部结束或超时；超时的任务仍以 `running` 返回。 */
    wait(taskIds: string[], options?: PluginSubagentAwaitOptions): Promise<PluginSubagentTaskSnapshot[]>;
  };
  /** 从工具执行回调的 `context` 里解出当前调用所属的委派来源。 */
  caller(context: unknown): PluginSubagentCaller | null;
  /**
   * 开一条可复用的隔离子代理线程（旁问线程），绑在当前会话上。
   *
   * 它不进任务列表：线程是插件自己持有的状态，生命周期由插件决定（`dispose`）。
   * 用量按每一次 `ask` 记进当前会话的 `subagentUsageHistory`（`origin: 'plugin'`，
   * 带插件 id），所以追问不会把前面的请求重复计费。
   */
  thread(options: PluginSubagentThreadOptions): PluginSubagentThread;
};

/**
 * 内核持有的委派入口。宿主实现，`PluginManager` 按插件 id 绑定后再交给插件——
 * 与 `promptSections` / `agentRegistry` 同一套处理方式，插件注册不到别人的名下。
 */
export type PluginSubagentRegistry = {
  forPlugin(pluginId: string): PluginSubagentApi;
};
