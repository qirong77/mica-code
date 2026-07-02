import { micaUi } from '@packages/mica-ui/index.js';
import { calculateCachedTokenRate, type AgentUsageRecord } from '@packages/mica-agent/index.js';
import type { MicaUiConversationMessage, MicaUiTextBlock } from '@packages/mica-ui/index.js';
import { AgentRuntime, type AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import { micaConfig } from '@packages/mica-config/index.js';
import {
  micaSession,
  type PersistedRuntimeSnapshot,
  type PersistedSession,
  type SessionStoreLike,
  type SessionSummary,
} from '@packages/mica-session/index.js';
import { getActiveContext } from '../app/activeContext.js';
import type { ApplicationContext } from '../app/ApplicationContext.js';

export type ResumeSessionResult = { ok: true; session: PersistedSession } | { ok: false; message: string };

export type SessionAgentAdapter = {
  getSnapshot(): AgentRuntimeSnapshot;
  loadSnapshot(snapshot: AgentRuntimeSnapshot): void;
  reloadConfig(resetSession?: boolean): void;
  toConversationMessages(): MicaUiConversationMessage[];
};

export type SessionConfigAdapter = {
  apply(snapshot: PersistedRuntimeSnapshot): void;
};

export type SessionUiAdapter = {
  restore(
    agent: SessionAgentAdapter,
    lastUsage: AgentUsageRecord | undefined,
    conversationMessages: MicaUiConversationMessage[],
  ): void;
};

export type SessionControllerOptions = {
  agent: SessionAgentAdapter;
  store?: SessionStoreLike;
  config?: SessionConfigAdapter;
  ui?: SessionUiAdapter;
};

export class SessionController {
  private currentSessionId = micaSession.createId();
  private currentTitleOverride: string | null = null;
  private readonly agent: SessionAgentAdapter;
  private readonly store: SessionStoreLike;
  private readonly config: SessionConfigAdapter;
  private readonly ui: SessionUiAdapter;

  constructor(agentOrOptions: SessionAgentAdapter | SessionControllerOptions, store?: SessionStoreLike) {
    const options = isSessionControllerOptions(agentOrOptions) ? agentOrOptions : { agent: agentOrOptions, store };
    this.agent = options.agent;
    this.store = options.store ?? micaSession.createStore();
    this.config = options.config ?? defaultSessionConfigAdapter;
    this.ui = options.ui ?? defaultSessionUiAdapter;
  }

  list(limit = 20): SessionSummary[] {
    return this.store.list(limit);
  }

  startNewSession(): void {
    this.currentSessionId = micaSession.createId();
    this.currentTitleOverride = null;
  }

  saveCurrent(options: { allowEmpty?: boolean } = {}): void {
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = getPersistableConversationMessages(this.agent);
    if (snapshot.messages.length === 0 && conversationMessages.length === 0 && !options.allowEmpty) return;

    const now = new Date().toISOString();
    const existing = this.store.load(this.currentSessionId);
    const session: PersistedSession = {
      version: 1,
      id: this.currentSessionId,
      title: this.currentTitleOverride ?? deriveTitle(getTitleConversationMessages(this.agent, conversationMessages)),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      cwd: process.cwd(),
      snapshot: toPersistedSnapshot(snapshot, conversationMessages),
    };
    this.store.save(session);
  }

  renameCurrent(title: string): void {
    const now = new Date().toISOString();
    const nextTitle = normalizeSessionTitle(title);
    this.currentTitleOverride = nextTitle;

    const existing = this.store.load(this.currentSessionId);
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = getPersistableConversationMessages(this.agent);
    this.store.save({
      version: 1,
      id: this.currentSessionId,
      title: nextTitle,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      cwd: process.cwd(),
      snapshot: existing?.snapshot ?? toPersistedSnapshot(snapshot, conversationMessages),
    });
  }

  getCurrentTitle(): string | null {
    return this.currentTitleOverride;
  }

  resume(id: string): ResumeSessionResult {
    const session = this.store.load(id);
    if (!session) return { ok: false, message: `Session not found: ${id}` };

    this.config.apply(session.snapshot);
    this.agent.reloadConfig(false);
    this.agent.loadSnapshot(fromPersistedSnapshot(session.snapshot));
    this.currentSessionId = session.id;
    const conversationMessages = getPersistedConversationMessages(session.snapshot, this.agent);
    const derivedTitle = deriveTitle(getTitleConversationMessages(this.agent, conversationMessages));
    this.currentTitleOverride = session.title === derivedTitle ? null : session.title;
    this.ui.restore(this.agent, session.snapshot.lastUsage, conversationMessages);
    return { ok: true, session };
  }
}

function normalizeSessionTitle(title: string): string {
  return title.trim() || 'Untitled session';
}

const defaultSessionConfigAdapter: SessionConfigAdapter = {
  apply: applySessionConfig,
};

const defaultSessionUiAdapter: SessionUiAdapter = {
  restore(agent, lastUsage, conversationMessages) {
    micaUi.conversation.setMessages(
      conversationMessages.length > 0 ? conversationMessages : agent.toConversationMessages(),
    );
    micaUi.conversation.clearResponseText();
    micaUi.conversation.clearPendingInput();
    micaUi.panels.thinkingText.set('');
    micaUi.panels.clearLogEntries();
    micaUi.panels.clearAgentTurnLogItems();
    micaUi.panels.clearLog();
    micaUi.panels.clearPluginUIs();
    micaUi.messageBar.clearMessages();
    micaUi.panels.status.idle();
    micaUi.terminalInput.clearText();

    if (lastUsage) {
      micaUi.panels.contextSize.set(lastUsage.totalTokens);
      micaUi.panels.cachedTokenRate.set(calculateCachedTokenRate(agent.getSnapshot().usageHistory));
    } else {
      micaUi.panels.contextSize.set(0);
      micaUi.panels.cachedTokenRate.set(0);
    }
  },
};

function isSessionControllerOptions(
  value: SessionAgentAdapter | SessionControllerOptions,
): value is SessionControllerOptions {
  return Boolean(value && typeof value === 'object' && 'agent' in value);
}

function toPersistedSnapshot(
  snapshot: AgentRuntimeSnapshot,
  conversationMessages: MicaUiConversationMessage[],
): PersistedRuntimeSnapshot {
  return {
    providerId: snapshot.providerId,
    model: snapshot.model,
    effort: snapshot.effort,
    messages: snapshot.messages,
    conversationMessages,
    usageHistory: snapshot.usageHistory,
    lastUsage: snapshot.lastUsage,
  };
}

function fromPersistedSnapshot(snapshot: PersistedRuntimeSnapshot): AgentRuntimeSnapshot {
  return {
    providerId: snapshot.providerId,
    model: snapshot.model,
    effort: snapshot.effort,
    messages: snapshot.messages,
    usageHistory: snapshot.usageHistory,
    lastUsage: snapshot.lastUsage,
  };
}

function getPersistableConversationMessages(agent: SessionAgentAdapter): MicaUiConversationMessage[] {
  const activeMessages =
    agent instanceof AgentRuntime
      ? getActiveContext<ApplicationContext>()?.agentSessions.findByAgent(agent)?.uiState.conversationMessages
      : undefined;
  return sanitizeConversationMessages(activeMessages?.length ? activeMessages : agent.toConversationMessages());
}

function getPersistedConversationMessages(
  snapshot: PersistedRuntimeSnapshot,
  agent: SessionAgentAdapter,
): MicaUiConversationMessage[] {
  const messages = sanitizeConversationMessages(snapshot.conversationMessages);
  return messages.length ? messages : sanitizeConversationMessages(agent.toConversationMessages());
}

function getTitleConversationMessages(
  agent: SessionAgentAdapter,
  fallbackMessages: MicaUiConversationMessage[],
): MicaUiConversationMessage[] {
  const historyMessages = sanitizeConversationMessages(agent.toConversationMessages());
  return historyMessages.length ? historyMessages : fallbackMessages;
}

function sanitizeConversationMessages(value: unknown): MicaUiConversationMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const sanitized = sanitizeConversationMessage(message);
    return sanitized ? [sanitized] : [];
  });
}

function sanitizeConversationMessage(value: unknown): MicaUiConversationMessage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const content = sanitizeConversationContent(record.content);
  if (content === null) return null;
  const displayContent = sanitizeConversationContent(record.displayContent);
  const display = displayContent === null ? {} : { displayContent };

  if (record.role === 'user') {
    return { role: 'user', content, ...display };
  }
  if (record.role === 'assistant') {
    return { role: 'assistant', content, ...display };
  }
  if (record.role === 'notice') {
    return {
      role: 'notice',
      content,
      ...display,
      ...(record.variant === 'recap' || record.variant === 'commit' || record.variant === 'compact'
        ? { variant: record.variant }
        : {}),
      ...(typeof record.command === 'string' ? { command: record.command } : {}),
    };
  }
  return null;
}

function sanitizeConversationContent(value: unknown): MicaUiConversationMessage['content'] | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;

  const blocks: MicaUiTextBlock[] = [];
  let omittedImages = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') omittedImages++;
  }

  if (blocks.length > 0) {
    return blocks.length === 1 ? blocks[0]!.text : blocks;
  }
  if (omittedImages > 0) return omittedImages === 1 ? '[Image]' : `[${omittedImages} images]`;
  return '';
}

function applySessionConfig(snapshot: PersistedRuntimeSnapshot) {
  micaConfig.update((config) => {
    const provider = config.providers.find((item) => item.id === snapshot.providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${snapshot.providerId}`);
    }
    const model = snapshot.model || provider.model || provider.models?.[0] || '';
    return {
      ...config,
      provider: provider.id,
      model,
      effort: micaConfig.clampProviderEffort(provider, snapshot.effort, model),
      contextWindowSize: micaConfig.getModelContextWindowSizeFromConfig(model),
    };
  });
}

function deriveTitle(messages: MicaUiConversationMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const text = firstUserMessage ? contentToText(firstUserMessage.content) : '';
  const title = text.replace(/\s+/g, ' ').trim();
  if (!title) return 'Untitled session';
  return title.length > 60 ? `${title.slice(0, 57)}...` : title;
}

function contentToText(content: MicaUiConversationMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
