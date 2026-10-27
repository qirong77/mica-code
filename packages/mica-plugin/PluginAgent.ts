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
  onIterationRewrite(pluginId: string, handler: PluginIterationRewriter): Disposable;
};
