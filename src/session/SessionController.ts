import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentUsageRecord } from '../../packages/mica-agent/index.js';
import type { MicaUiConversationMessage } from '../../packages/mica-ui/index.js';
import type { AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import { micaConfig } from '../../packages/mica-config/index.js';
import {
  createSessionId,
  SessionStore,
  type PersistedRuntimeSnapshot,
  type PersistedSession,
  type SessionStoreLike,
  type SessionSummary,
} from '../../packages/mica-session/index.js';

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
  restore(agent: SessionAgentAdapter, lastUsage: AgentUsageRecord | undefined): void;
};

export type SessionControllerOptions = {
  agent: SessionAgentAdapter;
  store?: SessionStoreLike;
  config?: SessionConfigAdapter;
  ui?: SessionUiAdapter;
};

export class SessionController {
  private currentSessionId = createSessionId();
  private readonly agent: SessionAgentAdapter;
  private readonly store: SessionStoreLike;
  private readonly config: SessionConfigAdapter;
  private readonly ui: SessionUiAdapter;

  constructor(agentOrOptions: SessionAgentAdapter | SessionControllerOptions, store?: SessionStoreLike) {
    const options = isSessionControllerOptions(agentOrOptions) ? agentOrOptions : { agent: agentOrOptions, store };
    this.agent = options.agent;
    this.store = options.store ?? new SessionStore();
    this.config = options.config ?? defaultSessionConfigAdapter;
    this.ui = options.ui ?? defaultSessionUiAdapter;
  }

  list(limit = 20): SessionSummary[] {
    return this.store.list(limit);
  }

  startNewSession(): void {
    this.currentSessionId = createSessionId();
  }

  saveCurrent(): void {
    const snapshot = this.agent.getSnapshot();
    if (snapshot.messages.length === 0) return;

    const now = new Date().toISOString();
    const existing = this.store.load(this.currentSessionId);
    const session: PersistedSession = {
      version: 1,
      id: this.currentSessionId,
      title: deriveTitle(this.agent.toConversationMessages()),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      cwd: process.cwd(),
      snapshot: toPersistedSnapshot(snapshot),
    };
    this.store.save(session);
  }

  resume(id: string): ResumeSessionResult {
    const session = this.store.load(id);
    if (!session) return { ok: false, message: `Session not found: ${id}` };

    this.config.apply(session.snapshot);
    this.agent.reloadConfig(false);
    this.agent.loadSnapshot(fromPersistedSnapshot(session.snapshot));
    this.currentSessionId = session.id;
    this.ui.restore(this.agent, session.snapshot.lastUsage);
    return { ok: true, session };
  }
}

const defaultSessionConfigAdapter: SessionConfigAdapter = {
  apply: applySessionConfig,
};

const defaultSessionUiAdapter: SessionUiAdapter = {
  restore(agent, lastUsage) {
    micaUI.conversation.setMessages(agent.toConversationMessages());
    micaUI.conversation.clearResponseText();
    micaUI.conversation.clearPendingInput();
    micaUI.panels.thinkingText.set('');
    micaUI.panels.clearLogEntries();
    micaUI.panels.clearAgentTurnLogItems();
    micaUI.panels.clearLog();
    micaUI.panels.clearPluginUIs();
    micaUI.messageBar.clearMessages();
    micaUI.panels.status.idle();
    micaUI.terminalInput.clearText();

    if (lastUsage) {
      micaUI.panels.contextSize.set(readContextTokens(lastUsage));
      micaUI.panels.cachedTokenRate.set(readTotalCachedTokenRate(agent));
    } else {
      micaUI.panels.contextSize.set(0);
      micaUI.panels.cachedTokenRate.set(0);
    }
  },
};

function isSessionControllerOptions(value: SessionAgentAdapter | SessionControllerOptions): value is SessionControllerOptions {
  return Boolean(value && typeof value === 'object' && 'agent' in value);
}

function toPersistedSnapshot(snapshot: AgentRuntimeSnapshot): PersistedRuntimeSnapshot {
  return {
    providerId: snapshot.providerId,
    model: snapshot.model,
    effort: snapshot.effort,
    messages: snapshot.messages,
    usageHistory: snapshot.usageHistory,
    lastUsage: snapshot.lastUsage,
  };
}

function readContextTokens(usage: AgentUsageRecord): number {
  return usage.totalTokens;
}

function readTotalCachedTokenRate(agent: SessionAgentAdapter): number {
  const snapshot = agent.getSnapshot();
  const totalInput = snapshot.usageHistory.reduce((sum, u) => sum + u.inputTokens, 0);
  const totalCached = snapshot.usageHistory.reduce((sum, u) => sum + (u.cachedInputTokens ?? 0), 0);
  if (totalInput <= 0) return 0;
  return Math.max(0, totalCached / totalInput);
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

function applySessionConfig(snapshot: PersistedRuntimeSnapshot) {
  micaConfig.update((config) => {
    const provider = config.providers.find((item) => item.id === snapshot.providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${snapshot.providerId}`);
    }
    return {
      ...config,
      provider: provider.id,
      model: snapshot.model || provider.model,
      effort: provider.supportsEffort === false ? 'none' : snapshot.effort,
      contextWindowSize: provider.contextWindowSize,
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
