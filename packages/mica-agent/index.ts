import { createSubAgent, OpenAIClient } from './providers/OpenAIClient.js';
import { buildSystemPrompt } from './prompt/index.js';

export const micaAgent = {
  createOpenAI: (options: ConstructorParameters<typeof OpenAIClient>[0]) => new OpenAIClient(options),
  createSubAgent,
  buildSystemPrompt,
};

export { BaseAgent } from './core/Agent.js';
export { createSubAgent, OpenAIClient } from './providers/OpenAIClient.js';
export { AnthropicAgent } from './providers/AnthropicAgent.js';
export { buildSystemPrompt, buildSystemPromptForTest } from './prompt/index.js';
export { createErrorLogItem, createThinkingLogItem, createToolCallLogItem } from './ui/AgentTurnLogItems.js';

export type {
  AgentQueryContent,
  AgentQueryOptions,
  AgentSnapshot,
  AgentUsageRecord,
  IAgent,
} from './core/Agent.js';
export type { OpenAIClientOptions, OpenAIUsageRecord, UsageRecord } from './providers/OpenAIClient.js';
