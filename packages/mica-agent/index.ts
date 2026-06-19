import { createOpenAIClient, createSubAgent, OpenAIClient } from './providers/OpenAIClient.js';
import { AnthropicAgent } from './providers/AnthropicAgent.js';
import { BaseAgent } from './core/Agent.js';
import { buildSystemPrompt, buildSystemPromptForTest } from './prompt/index.js';
import { createErrorLogItem, createThinkingLogItem, createToolCallLogItem } from './ui/AgentTurnLogItems.js';

export const micaAgent = {
  createOpenAI: createOpenAIClient,
  createSubAgent,
  OpenAIClient,
  AnthropicAgent,
  BaseAgent,
  buildSystemPrompt,
  buildSystemPromptForTest,
  createErrorLogItem,
  createThinkingLogItem,
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
