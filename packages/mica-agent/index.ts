import { createOpenAIClient, createSubAgent, OpenAIClient } from './providers/OpenAIClient.js';
import { OpenAIHistoryNormalizer } from './providers/OpenAIHistoryNormalizer.js';
import { AnthropicAgent } from './providers/AnthropicAgent.js';
import { AnthropicHistoryNormalizer } from './providers/AnthropicHistoryNormalizer.js';
import { BaseAgent } from './core/Agent.js';
import { buildSystemPrompt, buildSystemPromptForTest } from './prompt/index.js';

export const micaAgent = {
  /** 创建支持工具调用和流式事件的 OpenAI-compatible agent。 */
  createOpenAI: createOpenAIClient,
  /** 创建不启用工具、不使用 reasoning effort 的轻量子 agent。 */
  createSubAgent,
  OpenAIClient,
  OpenAIHistoryNormalizer,
  AnthropicAgent,
  AnthropicHistoryNormalizer,
  BaseAgent,
  /** 构建运行时系统提示词，包含工具、项目说明和环境上下文。 */
  buildSystemPrompt,
  /** 构建可注入固定参数的系统提示词，供 prompt 单测使用。 */
  buildSystemPromptForTest,
};

export type {
  AgentContentBlockParam,
  AgentConversationMessage,
  AgentQueryContent,
  AgentQueryOptions,
  AgentSnapshot,
  AgentUsageRecord,
  IAgent,
} from './core/Agent.js';
export type {
  ConversationContentBlock,
  ConversationImageBlock,
  ConversationItem,
  ConversationRoleItem,
  ConversationTextBlock,
  ConversationToolCallItem,
  ConversationToolResultItem,
  ConversationUnknownItem,
  ProviderHistoryNormalizer,
} from './core/Conversation.js';
export type { OpenAIClientOptions, OpenAIUsageRecord, UsageRecord } from './providers/OpenAIClient.js';
