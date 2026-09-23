import {
  recordSubagentTaskUsage,
  type AgentUsageRecord,
  type SubagentUsageRecord,
  type SubagentUsageTaskMeta,
} from '@packages/mica-agent/index.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';

/**
 * 记账一次 helper 子代理（commit / btw / compact 摘要）的模型请求：写进 owner 会话的
 * `snapshot.subagentUsageHistory`，并在主流程空闲时立刻落盘。
 *
 * 这些请求不属于任何 turn，没有别的保存时机，只留在内存里就等于没记（它们同样是
 * 本会话真实产生的开销）。turn 内的主请求不走这里，它们由 provider 的 `usageHistory` 记。
 */
export function recordHelperSubagentUsage(
  agent: CommandAgent,
  services: CommandRuntimeServices,
  requests: AgentUsageRecord[],
  meta: SubagentUsageTaskMeta,
): SubagentUsageRecord | null {
  const record = recordSubagentTaskUsage(agent, { usageHistory: requests }, meta);
  if (!record) return null;
  // turn 正在跑时不要插一次保存：那一轮自己的 checkpoint 会带上刚追加的用量。
  if (!agent.isRunning) services.getCurrentSessionController?.()?.saveCurrent({ allowEmpty: true });
  return record;
}
