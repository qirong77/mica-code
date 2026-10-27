import { recordSubagentTaskUsage } from '@packages/mica-agent/index.js';
import { micaContext } from '@packages/mica-context/index.js';
import type { AgentRuntime } from './AgentRuntime.js';

/**
 * 把「这段 provider 历史压小」这件事本身做成内核能力。
 *
 * 策略（什么时候压、压哪一种、压几次）归插件；这里只回答「怎么压」：`quick` 走本地
 * 清理，`model` 走摘要子代理。放在内核的理由是它是所有压缩入口共用的实现细节——
 * `/compact llm`、模型压缩、将来别的插件要用的是同一份 CompactionService 与同一套
 * 用量记账，各写一份迟早会在「摘要请求算不算用量」这种问题上分叉。
 */

export type CompactMessagesMode = 'quick' | 'model';

export type CompactMessagesResult = {
  messages: unknown[];
  savedTokens: number;
};

export async function compactAgentMessages(
  agent: AgentRuntime,
  messages: unknown[],
  mode: CompactMessagesMode,
): Promise<CompactMessagesResult> {
  const service = new micaContext.CompactionService();
  if (mode === 'quick') {
    const result = await service.compact({ messages, options: { toolResultsOnly: true } });
    return { messages: result.messages, savedTokens: Math.max(0, result.savedTokenEstimate) };
  }

  const result = await service.compact({
    messages,
    summarize: async (transcript, prompt) => {
      // 摘要必须走子代理、禁用工具：它共享父代理的工具注册表，session_* 之类的
      // 工具会去改正在被压缩的会话本身（与 /compact llm 同一条路径）。
      const subAgent = agent.createSubAgent({ systemPrompt: prompt, tools: false });
      const startedAt = new Date().toISOString();
      try {
        return await subAgent.query(
          [
            'Summarize this conversation into a compact checkpoint for the next coding agent.',
            'Preserve concrete paths, commands, validation results, user constraints, and pending work.',
            'Return only the requested <analysis> and <summary> blocks.',
            '',
            transcript,
          ].join('\n'),
        );
      } finally {
        // 摘要请求不进主 usageHistory（那会污染 ctx 与 lastUsage），但要记进
        // subagentUsageHistory，否则这次开销在 Stats 里不可见。
        recordSubagentTaskUsage(agent, subAgent, {
          taskId: 'auto-compact-summary',
          subagentType: 'auto-compact',
          description: '自动模型压缩摘要',
          model: agent.config.model,
          effort: 'none',
          status: 'completed',
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
    },
  });
  return { messages: result.messages, savedTokens: Math.max(0, result.savedTokenEstimate) };
}

/** 「没有可清理内容」与真正的失败要分开：前者不是错误，只是这次没压出东西。 */
export function isNothingToCompact(error: unknown): boolean {
  return micaContext.isCompactionNotNeededError(error);
}
