import { createModelClient, createSubAgent, registerModelClient } from './providers/createModelClient.js';
import { buildSystemPrompt } from './prompt/index.js';
import { isRetryableError } from './core/retry.js';

export const micaAgent = {
  isRetryableError,
  /** 按 provider.protocol 创建支持工具调用和流式事件的模型 client。 */
  createModelClient,
  /** 注册额外的 provider protocol client 实现。 */
  registerModelClient,
  /** 创建不启用工具、不使用 reasoning effort 的轻量子 agent。 */
  createSubAgent,
  /** 构建运行时系统提示词，包含工具、项目说明和环境上下文。 */
  buildSystemPrompt,
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
export type { AgentContentPartMapper } from './core/Content.js';
export type { AgentUsageSummary } from './core/Usage.js';
export { calculateCachedTokenRate, calculateUsageCachedTokenRate, summarizeUsageHistory } from './core/Usage.js';
export type {
  ConversationContentBlock,
  ConversationImageBlock,
  ConversationItem,
  ConversationRoleItem,
  ConversationTextBlock,
  ConversationToolCallItem,
  ConversationToolResultItem,
  ConversationUnknownItem,
  ConversationContentPartMapper,
} from './core/Conversation.js';
export { createModelClient, createSubAgent, registerModelClient } from './providers/createModelClient.js';
export type { ModelClientFactory } from './providers/createModelClient.js';
export { ChatCompletionsClient } from './providers/ChatCompletionsClient.js';
export { ResponsesClient } from './providers/ResponsesClient.js';
export type { ModelClientOptions } from './providers/types.js';
export type { ChatCompletionsUsageRecord } from './providers/ChatCompletionsClient.js';
export type { ResponsesUsageRecord } from './providers/ResponsesClient.js';
