import type { Disposable } from '@packages/mica-common/index.js';
import type { PluginIterationRewriter } from '@packages/mica-plugin/index.js';
import { compactAgentMessages } from './agentCompaction.js';
import type { AgentRuntime } from './AgentRuntime.js';

/**
 * 插件注册的「模型请求前重写历史」表。
 *
 * 表是进程级的：插件在 setup 里注册一次，之后所有 agent（多会话、子代理）都走同一份
 * 规则；handler 拿到的句柄指明这次请求属于哪个 agent，所以多会话不会串味。
 *
 * 顺序按注册顺序串起来：前一个的输出是后一个的输入，任何一个返回 null 表示「这一步不
 * 改」，整条链仍然继续。这样「A 插件裁剪、B 插件注入」可以叠加，而不需要谁去知道谁。
 *
 * 会话 id 由宿主注入：`AgentRuntime` 不持有会话身份（一条会话可以被 fork、可以被
 * 多个 agent 共用），由创建会话的那一层回答。
 */

type Registration = {
  pluginId: string;
  handler: PluginIterationRewriter;
};

type Summarize = (transcript: string, prompt: string) => Promise<string>;

/** 一次性运行的宿主（`mica exec`）注册成 `one-shot`：没有第二轮，改历史只改成本。 */
export type IterationHostMode = 'session' | 'one-shot';

const registrations: Registration[] = [];
let hostMode: IterationHostMode = 'session';
let resolveSessionId: (agent: AgentRuntime) => string | null = () => null;
let errorReporter: ((error: unknown, pluginId: string) => void) | null = null;

export function configureIterationRewrite(options: {
  mode?: IterationHostMode;
  resolveSessionId?: (agent: AgentRuntime) => string | null;
  onError?: (error: unknown, pluginId: string) => void;
}): void {
  if (options.mode) hostMode = options.mode;
  if (options.resolveSessionId) resolveSessionId = options.resolveSessionId;
  if (options.onError) errorReporter = options.onError;
}

export function registerIterationRewrite(pluginId: string, handler: PluginIterationRewriter): Disposable {
  const registration: Registration = { pluginId, handler };
  registrations.push(registration);
  return {
    dispose: () => {
      const index = registrations.indexOf(registration);
      if (index >= 0) registrations.splice(index, 1);
    },
  };
}

export function clearIterationRewrites(): void {
  registrations.length = 0;
}

export function iterationRewriteCount(): number {
  return registrations.length;
}

/**
 * 依次应用所有插件重写。单个插件失败只影响它自己那一步：重写历史是「顺手做的事」，
 * 一个插件的策略算错不该让正在跑的 turn 挂掉（错误交给宿主记进插件日志与健康状态）。
 */
export async function applyIterationRewrites(messages: unknown[], agent: AgentRuntime): Promise<unknown[] | null> {
  if (registrations.length === 0) return null;
  let current = messages;
  for (const registration of [...registrations]) {
    try {
      const next = await registration.handler(current, createAgentHandle(agent, registration.pluginId));
      if (Array.isArray(next)) current = next;
    } catch (error) {
      errorReporter?.(error, registration.pluginId);
    }
  }
  return current === messages ? null : current;
}

function createAgentHandle(agent: AgentRuntime, pluginId: string) {
  return {
    sessionId: resolveSessionId(agent),
    mode: hostMode,
    lastUsage: () => {
      const usage = agent.getSnapshot().lastUsage;
      if (!usage) return null;
      return { inputTokens: Number(usage.inputTokens) || 0, model: usage.model ?? agent.config.model };
    },
    getState: <T = unknown>() => agent.getPluginState(pluginId) as T | undefined,
    setState: (value: unknown) => agent.setPluginState(pluginId, value),
    compact: (messages: unknown[], options: { mode: 'quick' | 'model'; summarize?: Summarize }) =>
      compactAgentMessages(agent, messages, options),
  };
}
