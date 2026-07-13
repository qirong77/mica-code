import { createModelClient, createSubAgent, registerModelClient } from './providers/createModelClient.js';
import { buildSystemPrompt, getAgentRole, getRolesDirectory, listAgentRoles } from './prompt/index.js';
import { isRetryableError } from './core/retry.js';

export const micaAgent = {
  isRetryableError,
  /** 按 provider.protocol 创建支持工具调用和流式事件的模型 client。 */
  createModelClient,
  /** 注册额外的 provider protocol client 实现。 */
  registerModelClient,
  /** 创建子 agent；默认关闭工具，未指定时不使用 reasoning effort。 */
  createSubAgent,
  /** 构建运行时系统提示词，包含工具、项目说明和环境上下文。 */
  buildSystemPrompt,
  roles: {
    /** 列出内置 default role 与用户 role 文件。 */
    list: listAgentRoles,
    /** 按文件名读取 role；default 始终返回内置提示词。 */
    get: getAgentRole,
    /** 返回用户 role 文件目录。 */
    directory: getRolesDirectory,
  },
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
export { AgentMaxTurnsError, throwIfAgentMaxTurnsReached } from './core/Agent.js';
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
export { DEFAULT_ROLE_NAME } from './prompt/index.js';
export type { AgentRole, BuildSystemPromptOptions } from './prompt/index.js';
export { createModelClient, createSubAgent, registerModelClient } from './providers/createModelClient.js';
export type { ModelClientFactory } from './providers/createModelClient.js';
export { ChatCompletionsClient } from './providers/ChatCompletionsClient.js';
export { ResponsesClient } from './providers/ResponsesClient.js';
export type { ModelClientOptions } from './providers/types.js';
export type { ChatCompletionsUsageRecord } from './providers/ChatCompletionsClient.js';
export type { ResponsesUsageRecord } from './providers/ResponsesClient.js';
