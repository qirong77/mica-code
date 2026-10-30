import type { Disposable } from '@packages/mica-common/index.js';

/**
 * 插件与「模型请求」之间的扩展面。
 *
 * 自动压缩是第一个需要它的插件，但它不是自动压缩专属的：任何想影响「这次请求要发什么
 * 历史」的插件（历史裁剪、按会话注入上下文、按成本降级）都走同一套入口，内核不需要再
 * 为每种策略各开一条通路。
 *
 * 边界刻意定得很窄：插件拿到的是一次模型请求所属的那个 agent 的**句柄**，而不是 agent
 * 本身。句柄只暴露「最近一次用量、本插件的会话状态、压缩这段历史」三件事，插件改不到
 * provider 配置、改不到别的插件状态、也拿不到会话读写面。
 */

export type PluginAgentUsage = {
  /** 这次请求发送的上下文 token 数。 */
  inputTokens: number;
  /** 产生这次用量的模型。 */
  model: string;
};

export type PluginCompactMode = 'quick' | 'model';

export type PluginCompactResult = {
  messages: unknown[];
  /** 这次压缩大约省下多少 token（估算值，仅用于展示与阈值判断）。 */
  savedTokens: number;
};

/**
 * 一次「轮次之外的压缩」的结果。
 *
 * `skipped` 不是错误，也不消耗次数：`busy` 是「现在不能写」（这一轮正在跑、另一个
 * 进程持有 turn lease、用户刚好按下发送），`empty` 是「历史里没有可清理的内容」——
 * 干净的会话每次敲字都会走到后者。分开两种原因是为了让插件能记一条能读的日志，
 * 而不是把「本来就没得压」和「压不上」混成一句。
 */
export type PluginIdleCompactOutcome =
  | {
      status: 'applied';
      /** 这次压缩大约省下多少 token（估算值，仅用于展示）。 */
      savedTokens: number;
      /** 压缩前后的估算占用，用来在界面上写成「792.5K → 46.2K」而不是一个孤零零的节省量。 */
      beforeTokens: number;
      afterTokens: number;
    }
  | { status: 'skipped'; reason: 'busy' | 'empty' };

/**
 * 压缩真正应用之后、落盘之前的那一刻。
 *
 * 插件在这里写会话状态、发 notice：宿主随后会把压缩结果与这些写入**一起**存下来。
 * 压缩结束之后再写就晚了——那时宿主已经落过盘（或租约已经放掉），下一轮才可能被
 * 带下去，而用户可能直接关掉页面。回调抛错会让宿主回滚这次压缩并不落盘。
 */
export type PluginIdleCompactHook = {
  /** 字段含义与最终结果一致，压缩结果随这条回调一起落盘。 */
  afterApply?: (result: { savedTokens: number; beforeTokens: number; afterTokens: number }) => void;
};

/** 一次模型请求所属 agent 的句柄。 */
export type PluginAgentHandle = {
  readonly sessionId: string | null;
  /**
   * 宿主形态。
   *
   * `one-shot` 是一次性运行（`mica exec`）：没有第二轮，任何「省下后续请求成本」的策略
   * 在那里都只会改变这一次运行的开销与结果，所以会改变成本或输出的插件应当只对
   * `session` 生效。
   */
  readonly mode: 'session' | 'one-shot';
  lastUsage(): PluginAgentUsage | null;
  /** 本插件在这条会话里的状态；没写过返回 undefined。 */
  getState<T = unknown>(): T | undefined;
  setState(value: unknown): void;
  /**
   * 压缩这段 provider 消息。`quick` 只做本地清理（不调用模型），`model` 走摘要子代理。
   *
   * 失败以异常的形态抛回给插件：压缩是插件的策略，失败要不要中断、要不要上报都由插件
   * 决定，内核不替它吞掉。
   */
  compact(messages: unknown[], options: { mode: PluginCompactMode }): Promise<PluginCompactResult>;
};

/**
 * 每次模型请求前的历史重写。返回 `null` 表示「不改」，返回数组则替换接下来要发送的历史。
 */
export type PluginIterationRewriter = (
  messages: unknown[],
  agent: PluginAgentHandle,
) => Promise<unknown[] | null> | unknown[] | null;

/**
 * 内核持有的重写表。宿主提供，`PluginManager` 按插件绑定 id 后再交给插件——
 * 与 `promptSections` 同一套处理方式，插件无法注册到别人的名下。
 */
export type PluginAgentRegistry = {
  /** 宿主形态，原样交给 `ctx.agent.mode`。 */
  mode: 'session' | 'one-shot';
  onIterationRewrite(pluginId: string, handler: PluginIterationRewriter): Disposable;
  /**
   * 在轮次之外对当前会话**已经存下来的**历史做一次快速压缩（只做本地清理，不调用模型）。
   *
   * 与 `onIterationRewrite` 里的 `compact` 的区别是「改哪一份」：那里改的是一次请求
   * 即将发送的历史（不落盘），这里改的是会话文件本身，所以它能真正省掉下一轮请求的
   * 上下文——用户空闲很久之后重新敲字时，压缩因此可以提前发生，而不是等请求已经在路上。
   *
   * 宿主给不出这条通路时省略（`mica exec` 不落盘，TUI 由 `/compact` 负责）；插件必须
   * 把它当成可选能力，不能因为读不到就报错。
   */
  compactIdleHistory?(pluginId: string, options?: PluginIdleCompactHook): Promise<PluginIdleCompactOutcome>;
};
