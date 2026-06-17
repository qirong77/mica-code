import type { MicaUiConversationMessage, MicaUiContentBlockParam } from '../../mica-ui/types.js';

export type AgentQueryContent = string | MicaUiContentBlockParam[];

export type AgentUsageRecord = {
  provider: string;
  turnId: number;
  requestIndex: number;
  messageCount: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  paidTokenRate: number;
};

export type AgentCallbacks = {
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall?: (name: string, args: string, id?: string) => void;
  onToolResult?: (name: string, result: string, id?: string) => void;
  onUsage?: (usage: AgentUsageRecord) => void;
};

export type AgentQueryOptions = {
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
};

export type AgentSnapshot<TMessage = unknown, TUsage extends AgentUsageRecord = AgentUsageRecord> = {
  model: string;
  messages: TMessage[];
  usageHistory: TUsage[];
  lastUsage: TUsage | undefined;
  conversationMessages: MicaUiConversationMessage[];
};

export interface IAgent<
  TOptions = unknown,
  TMessage = unknown,
  TUsage extends AgentUsageRecord = AgentUsageRecord,
> extends AgentCallbacks {
  model: string;
  messages: TMessage[];
  usageHistory: TUsage[];
  lastUsage: TUsage | undefined;

  configure(options: TOptions): void;
  reset(): void;
  query(question: AgentQueryContent, options?: AgentQueryOptions): Promise<string>;
  toConversationMessages(): MicaUiConversationMessage[];
  getSnapshot(): AgentSnapshot<TMessage, TUsage>;
  loadSnapshot(snapshot: AgentSnapshot<TMessage, TUsage>): void;
}

export abstract class BaseAgent<
  TOptions,
  TMessage,
  TUsage extends AgentUsageRecord = AgentUsageRecord,
> implements IAgent<TOptions, TMessage, TUsage> {
  abstract model: string;
  abstract messages: TMessage[];
  abstract usageHistory: TUsage[];
  abstract lastUsage: TUsage | undefined;

  onText: ((text: string) => void) | undefined;
  onThinking: ((thinking: string) => void) | undefined;
  onToolCall: ((name: string, args: string, id?: string) => void) | undefined;
  onToolResult: ((name: string, result: string, id?: string) => void) | undefined;
  onUsage: ((usage: AgentUsageRecord) => void) | undefined;

  abstract configure(options: TOptions): void;
  abstract reset(): void;
  abstract query(question: AgentQueryContent, options?: AgentQueryOptions): Promise<string>;
  abstract toConversationMessages(): MicaUiConversationMessage[];
  abstract loadSnapshot(snapshot: AgentSnapshot<TMessage, TUsage>): void;

  getSnapshot(): AgentSnapshot<TMessage, TUsage> {
    return {
      model: this.model,
      messages: this.messages,
      usageHistory: this.usageHistory,
      lastUsage: this.lastUsage,
      conversationMessages: this.toConversationMessages(),
    };
  }

  protected textMessage(role: 'user' | 'assistant', text: string): MicaUiConversationMessage | null {
    if (!text) return null;
    return { role, content: [{ type: 'text', text }] };
  }

  protected contentBlocksToText(blocks: MicaUiContentBlockParam[]): string {
    return blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
}
