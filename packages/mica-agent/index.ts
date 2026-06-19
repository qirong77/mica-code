import { createOpenAIClient, createSubAgent, OpenAIClient } from './providers/OpenAIClient.js';
import { AnthropicAgent } from './providers/AnthropicAgent.js';
import { BaseAgent } from './core/Agent.js';
import { buildSystemPrompt, buildSystemPromptForTest } from './prompt/index.js';
import { createErrorLogItem, createThinkingLogItem, createToolCallLogItem } from './ui/AgentTurnLogItems.js';

export const micaAgent = {
  /** 创建支持工具调用和流式事件的 OpenAI-compatible agent。 */
  createOpenAI: createOpenAIClient,
  /** 创建不启用工具、不使用 reasoning effort 的轻量子 agent。 */
  createSubAgent,
  OpenAIClient,
  AnthropicAgent,
  BaseAgent,
  /** 构建运行时系统提示词，包含工具、项目说明和环境上下文。 */
  buildSystemPrompt,
  /** 构建可注入固定参数的系统提示词，供 prompt 单测使用。 */
  buildSystemPromptForTest,
  /** 创建 agent 错误日志 UI item。 */
  createErrorLogItem,
  /** 创建 agent thinking 流式日志 UI item。 */
  createThinkingLogItem,
  /** 创建 agent 工具调用日志 UI item。 */
  createToolCallLogItem,
};

export type {
  AgentQueryContent,
  AgentQueryOptions,
  AgentSnapshot,
  AgentUsageRecord,
  IAgent,
} from './core/Agent.js';
export type { OpenAIClientOptions, OpenAIUsageRecord, UsageRecord } from './providers/OpenAIClient.js';
