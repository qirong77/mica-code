import { micaUi } from '@packages/mica-ui/index.js';
import {
  DEFAULT_ROLE_NAME,
  calculateCachedTokenRate,
  micaAgent,
  type AgentUsageRecord,
} from '@packages/mica-agent/index.js';
import type { MicaUiCommandStatus, MicaUiConversationMessage, MicaUiTextBlock } from '@packages/mica-ui/index.js';
import { AgentRuntime, type AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import { micaConfig, providerSupportsModel } from '@packages/mica-config/index.js';
import {
  micaSession,
  type PersistedRuntimeSnapshot,
  type PersistedSession,
  type PersistedSessionTurnState,
  type SessionStoreLike,
  type SessionSummary,
} from '@packages/mica-session/index.js';
import { getActiveContext } from '../app/activeContext.js';
import { micaContext } from '@packages/mica-context/index.js';
import type { ApplicationContext } from '../app/ApplicationContext.js';

export type ResumeSessionResult =
  | { ok: true; session: PersistedSession; roleFallback?: { missing: string; fallback: string } }
  | { ok: false; message: string };

export type SessionAgentAdapter = {
  getSnapshot(): AgentRuntimeSnapshot;
  loadSnapshot(snapshot: AgentRuntimeSnapshot): void;
  reloadConfig(resetSession?: boolean): void;
  toConversationMessages(): MicaUiConversationMessage[];
};

export type SessionConfigAdapter = {
  apply(snapshot: PersistedRuntimeSnapshot): PersistedRuntimeSnapshot | void;
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
  private currentTitleSource: 'derived' | 'auto' | 'manual' = 'derived';
  private currentTurnState: PersistedSessionTurnState = 'completed';
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
    return this.store.list(limit).map((summary) => {
      if (!isInternalCompactText(summary.title)) return summary;
      const session = this.store.load(summary.id);
      if (!session) return summary;
      return { ...summary, title: deriveTitle(getPersistedConversationMessages(session.snapshot)) };
    });
  }

  listRecent(limit = 20): SessionSummary[] {
    return this.store.listRecent(limit).map((summary) => {
      if (!isInternalCompactText(summary.title)) return summary;
      const session = this.store.load(summary.id);
      if (!session) return summary;
      return { ...summary, title: deriveTitle(getPersistedConversationMessages(session.snapshot)) };
    });
  }

  load(id: string): PersistedSession | null {
    return this.store.load(id);
  }

  startNewSession(): void {
    this.discardCurrentIfEmpty();
    this.currentSessionId = micaSession.createId();
    this.currentTitleOverride = null;
    this.currentTitleSource = 'derived';
    this.currentTurnState = 'completed';
  }

  saveCurrent(
    options: { allowEmpty?: boolean; turnState?: PersistedSessionTurnState; preserveTitle?: boolean } = {},
  ): boolean {
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = getPersistableConversationMessages(this.agent);
    this.currentTurnState = options.turnState ?? this.currentTurnState;
    if (!hasConversation(snapshot.messages, conversationMessages) && !options.allowEmpty) {
      this.store.delete(this.currentSessionId);
      return false;
    }

    const now = new Date().toISOString();
    const existing = this.store.load(this.currentSessionId);
    const derivedTitle = deriveTitle(getTitleConversationMessages(this.agent, conversationMessages));
    const persistedTitle =
      options.preserveTitle && existing && !isInternalCompactText(existing.title) ? existing.title : undefined;
    const session: PersistedSession = {
      version: 1,
      id: this.currentSessionId,
      title: this.currentTitleOverride ?? persistedTitle ?? derivedTitle,
      titleSource: this.currentTitleOverride ? this.currentTitleSource : (existing?.titleSource ?? 'derived'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
      cwd: process.cwd(),
      turnState: this.currentTurnState,
      snapshot: toPersistedSnapshot(snapshot, conversationMessages),
    };
    if (existing && sessionsEqual(existing, session)) return true;
    session.updatedAt = now;
    this.store.save(session);
    return true;
  }

  renameCurrent(title: string, source: 'auto' | 'manual' = 'manual'): void {
    const now = new Date().toISOString();
    const nextTitle = normalizeSessionTitle(title);
    this.currentTitleOverride = nextTitle;
    this.currentTitleSource = source;

    const existing = this.store.load(this.currentSessionId);
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = getPersistableConversationMessages(this.agent);
    this.store.save({
      version: 1,
      id: this.currentSessionId,
      title: nextTitle,
      titleSource: source,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      cwd: process.cwd(),
      turnState: existing?.turnState ?? this.currentTurnState,
      snapshot: existing?.snapshot ?? toPersistedSnapshot(snapshot, conversationMessages),
    });
  }

  getCurrentTitle(): string | null {
    return this.currentTitleOverride;
  }

  hasManualTitle(): boolean {
    if (this.currentTitleSource === 'manual') return true;
    const existing = this.store.load(this.currentSessionId);
    if (!existing) return false;
    if (existing.titleSource === 'manual') return true;
    if (existing.titleSource) return false;
    const messages = getPersistedConversationMessages(existing.snapshot);
    return existing.title !== deriveTitle(getTitleConversationMessages(this.agent, messages));
  }

  tryAutoRename(expectedSessionId: string, title: string): boolean {
    if (this.currentSessionId !== expectedSessionId || this.hasManualTitle()) return false;
    this.renameCurrent(title, 'auto');
    return true;
  }

  getCurrentSessionId(): string {
    return this.currentSessionId;
  }

  resume(id: string): ResumeSessionResult {
    const session = this.store.load(id);
    if (!session) return { ok: false, message: `Session not found: ${id}` };

    return this.resumeLoaded(session);
  }

  resumeLoaded(session: PersistedSession): ResumeSessionResult {
    if (session.id !== this.currentSessionId) this.discardCurrentIfEmpty();
    const requestedRole = session.snapshot.role ?? DEFAULT_ROLE_NAME;
    const restoredRole = resolveSnapshotRole(requestedRole);
    const resolvedSnapshot = this.config.apply(session.snapshot) ?? session.snapshot;
    this.agent.reloadConfig(false);
    this.agent.loadSnapshot(fromPersistedSnapshot(resolvedSnapshot, restoredRole));
    this.currentSessionId = session.id;
    this.currentTurnState = session.turnState ?? 'completed';
    const conversationMessages = getPersistedConversationMessages(session.snapshot);
    const derivedTitle = deriveTitle(getTitleConversationMessages(this.agent, conversationMessages));
    const restoredTitle = isInternalCompactText(session.title) ? derivedTitle : session.title;
    const restoredSession = restoredTitle === session.title ? session : { ...session, title: restoredTitle };
    this.currentTitleSource = session.titleSource ?? (restoredTitle === derivedTitle ? 'derived' : 'manual');
    this.currentTitleOverride = this.currentTitleSource === 'derived' ? null : restoredTitle;
    this.ui.restore(this.agent, session.snapshot.lastUsage, conversationMessages);
    return {
      ok: true,
      session: restoredSession,
      ...(requestedRole === restoredRole ? {} : { roleFallback: { missing: requestedRole, fallback: restoredRole } }),
    };
  }

  private discardCurrentIfEmpty(): boolean {
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = getPersistableConversationMessages(this.agent);
    if (hasConversation(snapshot.messages, conversationMessages)) return false;
    return this.store.delete(this.currentSessionId);
  }
}

function sessionsEqual(left: PersistedSession, right: PersistedSession): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasConversation(providerMessages: unknown[], conversationMessages: MicaUiConversationMessage[]): boolean {
  if (conversationMessages.some((message) => message.role === 'user' || message.role === 'assistant')) return true;
  return providerMessages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const role = (message as { role?: unknown }).role;
    return role === 'user' || role === 'assistant';
  });
}

function normalizeSessionTitle(title: string): string {
  return title.trim() || 'Untitled session';
}

const defaultSessionConfigAdapter: SessionConfigAdapter = {
  apply: applySessionConfig,
};

const defaultSessionUiAdapter: SessionUiAdapter = {
  restore(agent, lastUsage, conversationMessages) {
    micaUi.conversation.setMessages(conversationMessages);
    micaUi.conversation.clearResponseText();
    micaUi.conversation.clearPendingInput();
    micaUi.panels.thinkingText.set('');
    micaUi.panels.clearAgentTurnLogItems();
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
    protocol: snapshot.protocol,
    model: snapshot.model,
    effort: snapshot.effort,
    role: snapshot.role,
    messages: snapshot.messages,
    conversationMessages,
    usageHistory: snapshot.usageHistory,
    lastUsage: snapshot.lastUsage,
  };
}

function fromPersistedSnapshot(
  snapshot: PersistedRuntimeSnapshot,
  role = resolveSnapshotRole(snapshot.role),
): AgentRuntimeSnapshot {
  return {
    providerId: snapshot.providerId,
    protocol: snapshot.protocol,
    model: snapshot.model,
    effort: snapshot.effort,
    role,
    messages: snapshot.messages,
    usageHistory: snapshot.usageHistory,
    lastUsage: snapshot.lastUsage,
  };
}

function resolveSnapshotRole(roleName?: string): string {
  return roleName ? (micaAgent.roles.get(roleName)?.name ?? DEFAULT_ROLE_NAME) : DEFAULT_ROLE_NAME;
}

function getPersistableConversationMessages(agent: SessionAgentAdapter): MicaUiConversationMessage[] {
  const activeMessages =
    agent instanceof AgentRuntime
      ? getActiveContext<ApplicationContext>()?.agentSessions.findByAgent(agent)?.uiState.conversationMessages
      : undefined;
  return sanitizeConversationMessages(activeMessages?.length ? activeMessages : agent.toConversationMessages());
}

function getPersistedConversationMessages(snapshot: PersistedRuntimeSnapshot): MicaUiConversationMessage[] {
  return sanitizeConversationMessages(snapshot.conversationMessages);
}

function getTitleConversationMessages(
  agent: SessionAgentAdapter,
  fallbackMessages: MicaUiConversationMessage[],
): MicaUiConversationMessage[] {
  const historyMessages = sanitizeConversationMessages(agent.toConversationMessages());
  // Compact rewrites model history so that it starts with synthetic user
  // messages. The UI conversation still contains the original prompt and is
  // therefore the authoritative title source when one is available.
  return fallbackMessages.some(isTitleUserMessage) ? fallbackMessages : historyMessages;
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
      ...(record.variant === 'commit' ||
      record.variant === 'config' ||
      record.variant === 'compact' ||
      record.variant === 'error'
        ? { variant: record.variant }
        : {}),
      ...(typeof record.command === 'string' ? { command: record.command } : {}),
      ...(isNoticeStatus(record.status) ? { status: record.status } : {}),
    };
  }
  return null;
}

function isNoticeStatus(value: unknown): value is MicaUiCommandStatus {
  return value === 'running' || value === 'success' || value === 'warning' || value === 'error' || value === 'info';
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

export function applySessionConfig(snapshot: PersistedRuntimeSnapshot): PersistedRuntimeSnapshot {
  let resolvedSnapshot = snapshot;
  micaConfig.update((config) => {
    const snapshotProvider = config.providers.find((item) => item.id === snapshot.providerId);
    const provider = snapshotProvider ?? config.providers.find((item) => item.id === config.provider) ?? config.providers[0];
    if (!provider) return config;

    const snapshotModelAvailable = providerSupportsModel(provider, snapshot.model);
    const model =
      snapshotProvider && snapshotModelAvailable
        ? snapshot.model
        : provider.id === config.provider && providerSupportsModel(provider, config.model)
          ? config.model
          : (provider.models?.[0] ?? snapshot.model);
    const effort =
      provider.supportsEffort === false ? 'none' : micaConfig.normalizeModelEffort(model, snapshot.effort);
    resolvedSnapshot = {
      ...snapshot,
      providerId: provider.id,
      protocol: provider.protocol,
      model,
      effort,
    };
    return {
      ...config,
      provider: provider.id,
      model,
      effort,
      contextWindowSize: micaConfig.getModelRule(model).contextSize,
    };
  });
  return resolvedSnapshot;
}

function deriveTitle(messages: MicaUiConversationMessage[]): string {
  const firstUserMessage = messages.find(isTitleUserMessage);
  const text = firstUserMessage ? contentToText(firstUserMessage.content) : '';
  const title = text.replace(/\s+/g, ' ').trim();
  if (!title) return 'Untitled session';
  return title.length > 60 ? `${title.slice(0, 57)}...` : title;
}

function isTitleUserMessage(message: MicaUiConversationMessage): boolean {
  if (message.role !== 'user') return false;
  const text = contentToText(message.content).trimStart();
  return !isInternalCompactText(text);
}

function isInternalCompactText(text: string): boolean {
  const normalized = text.trimStart();
  return (
    normalized.startsWith(micaContext.COMPACT_BOUNDARY_PREFIX) ||
    normalized.startsWith(micaContext.COMPACT_SUMMARY_PREFIX)
  );
}

function contentToText(content: MicaUiConversationMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
