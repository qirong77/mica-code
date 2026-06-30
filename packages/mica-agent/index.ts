import { createModelClient, createSubAgent } from './providers/createModelClient.js';
import { ChatCompletionsClient } from './providers/ChatCompletionsClient.js';
import { ChatCompletionsHistoryNormalizer } from './providers/ChatCompletionsHistoryNormalizer.js';
import { ResponsesClient } from './providers/ResponsesClient.js';
import { ResponsesHistoryNormalizer } from './providers/ResponsesHistoryNormalizer.js';
import { AnthropicAgent } from './providers/AnthropicAgent.js';
import { AnthropicHistoryNormalizer } from './providers/AnthropicHistoryNormalizer.js';
import { BaseAgent } from './core/Agent.js';
import { calculateCachedTokenRate, calculateUsageCachedTokenRate, summarizeUsageHistory } from './core/Usage.js';
import { buildSystemPrompt, buildSystemPromptForTest } from './prompt/index.js';
import { isRetryableError } from './core/retry.js';

export const micaAgent = {
  isRetryableError,
  /** 按 provider.protocol 创建支持工具调用和流式事件的模型 client。 */
  createModelClient,
  /** 创建不启用工具、不使用 reasoning effort 的轻量子 agent。 */
  createSubAgent,
  ChatCompletionsClient,
  ChatCompletionsHistoryNormalizer,
  ResponsesClient,
  ResponsesHistoryNormalizer,
  AnthropicAgent,
  AnthropicHistoryNormalizer,
  BaseAgent,
  calculateCachedTokenRate,
  calculateUsageCachedTokenRate,
  summarizeUsageHistory,
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
export { providerContentToAgentContent } from './core/Content.js';
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
  ProviderHistoryNormalizer,
} from './core/Conversation.js';
export { providerContentToConversationBlocks } from './core/Conversation.js';
export { createModelClient, createSubAgent } from './providers/createModelClient.js';
export { ChatCompletionsClient } from './providers/ChatCompletionsClient.js';
export { ChatCompletionsHistoryNormalizer } from './providers/ChatCompletionsHistoryNormalizer.js';
export { ResponsesClient } from './providers/ResponsesClient.js';
export { ResponsesHistoryNormalizer } from './providers/ResponsesHistoryNormalizer.js';
export { AnthropicAgent } from './providers/AnthropicAgent.js';
export { AnthropicHistoryNormalizer } from './providers/AnthropicHistoryNormalizer.js';
export type { ModelClientOptions } from './providers/types.js';
export type { ChatCompletionsUsageRecord } from './providers/ChatCompletionsClient.js';
export type { ResponsesUsageRecord } from './providers/ResponsesClient.js';
export type { AnthropicUsageRecord } from './providers/AnthropicAgent.js';
