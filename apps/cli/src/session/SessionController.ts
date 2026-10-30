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
  type PersistedSnapshotDisplayUsage,
  type PersistedSessionTurnState,
  type SessionStoreLike,
  type SessionSummary,
} from '@packages/mica-session/index.js';
import { getActiveContext } from '../app/activeContext.js';
import { micaContext } from '@packages/mica-context/index.js';
import { stripMediaPlaceholders } from '@packages/mica-common/promptText.js';
import type { ApplicationContext } from '../app/ApplicationContext.js';

export type ResumeSessionResult =
  | { ok: true; session: PersistedSession; roleFallback?: { missing: string; fallback: string } }
  | { ok: false; message: string };

export type SessionAgentAdapter = {
  getSnapshot(): AgentRuntimeSnapshot;
  loadSnapshot(snapshot: AgentRuntimeSnapshot): void;
  reloadConfig(resetSession?: boolean): void;
  /** 可选：用户显式改能力（`/capabilities`）。标记为会话定制，之后不再跟随默认值。 */
  setCapabilities?(selection: NonNullable<AgentRuntimeSnapshot['capabilitySelection']>): unknown;
  /** 可选：`/clear`、`/new` 之后回到「跟随 config 默认值」的新会话状态。 */
  resetCapabilitiesToDefaults?(): unknown;
  /** 可选：`/clear`、`/new` 之后清空插件在会话里的状态（含会话笔记）。 */
  clearSession?(): void;
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
  /** 这条会话派生自哪条会话；resume 时从文件读回来，新会话由调用方给。 */
  private currentParentSessionId: string | null = null;
  private currentPersistedSignature: string | null = null;
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

  /**
   * 开一条新会话。
   *
   * `parentSessionId` 是"谁派生的这条会话"（spawn 出来的子会话、fork 出的分支）。
   * 只影响侧栏的归档方式，不改变这条会话的任何行为——父会话在不在、跑没跑，
   * 都不影响这里。
   */
  startNewSession(options: { parentSessionId?: string | null } = {}): void {
    this.discardCurrentIfEmpty();
    this.currentSessionId = micaSession.createId();
    this.currentParentSessionId = normalizeParentSessionId(options.parentSessionId);
    // 能力开关属于会话，不属于 agent：新会话重新跟随 config 里的默认值（不继承
    // 上一条会话关掉的工具，也不继承它的「已定制」状态）。
    this.agent.resetCapabilitiesToDefaults?.();
    // 插件状态同样属于会话：新会话从空白开始，不继承上一轮攒下的结论（笔记等）。
    this.agent.clearSession?.();
    this.currentTitleOverride = null;
    this.currentTitleSource = 'derived';
    this.currentTurnState = 'completed';
    this.currentPersistedSignature = null;
  }

  /** 当前会话的父会话 id（没有则为 null）。 */
  getParentSessionId(): string | null {
    return this.currentParentSessionId;
  }

  saveCurrent(
    options: {
      allowEmpty?: boolean;
      turnState?: PersistedSessionTurnState;
      preserveTitle?: boolean;
      conversationMessages?: MicaUiConversationMessage[];
      /** 压缩后的上下文占用，仅供界面展示（见 resolveDisplayUsage）。 */
      displayUsage?: PersistedSnapshotDisplayUsage;
    } = {},
  ): boolean {
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = options.conversationMessages ?? getPersistableConversationMessages(this.agent);
    this.currentTurnState = options.turnState ?? this.currentTurnState;
    if (
      !hasConversation(snapshot.messages, conversationMessages) &&
      !options.allowEmpty &&
      this.currentTitleSource !== 'manual'
    ) {
      this.store.delete(this.currentSessionId);
      // The file is gone, so the recorded signature no longer describes
      // anything on disk. Clearing it keeps the next save (this session is
      // still the live one) from being treated as "another writer owns it".
      this.currentPersistedSignature = null;
      return false;
    }

    // `allowEmpty` 是「草稿也存一份」，不是「允许把已有历史写空」：resume 没把历史装进
    // agent 的进程（插件面板动作、能力开关这类不跑 turn 的入口）如果照原样存，
    // 用户几百条对话会被一次点击抹掉。宁可这次不落盘。
    if (
      options.allowEmpty &&
      !hasConversation(snapshot.messages, conversationMessages) &&
      this.persistedConversationCount() > 0
    ) {
      return false;
    }

    const now = new Date().toISOString();
    const existing = this.store.load(this.currentSessionId);
    if (this.currentPersistedSignature !== null && !existing) {
      // The file was removed underneath us (another process, or our own empty
      // save above) while this session stayed the live one. Returning early
      // would turn every later save of this process into a silent no-op and
      // lose the whole conversation at the next unexpected termination, so
      // forget the stale signature and write again.
      this.currentPersistedSignature = null;
    }
    // A signature mismatch against an existing file means another process
    // persisted the session since our last save (a second app-server host or a
    // CLI resume). Prefer keeping the other writer's snapshot authoritative,
    // but never skip the save forever: headless hosts (app-server / exec) do
    // not call refreshFromStore between turns, so a permanent skip would
    // silently drop every later turn of this host. Falling back to writing the
    // current in-memory snapshot (revision bump below) guarantees the host's
    // own turns survive; the next refresh converges the signature.
    const derivedTitle = deriveTitle(getTitleConversationMessages(this.agent, conversationMessages));
    const persistedTitle =
      options.preserveTitle && existing && !isInternalCompactText(existing.title) ? existing.title : undefined;
    const session: PersistedSession = {
      version: 1,
      revision: existing?.revision,
      id: this.currentSessionId,
      title: this.currentTitleOverride ?? persistedTitle ?? derivedTitle,
      titleSource: this.currentTitleOverride ? this.currentTitleSource : (existing?.titleSource ?? 'derived'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
      cwd: process.cwd(),
      // 父会话写在第一次保存时，之后由已有的值续写：父会话被删掉了也保留这条线索
      // （指向一个不存在的 id 只是让侧栏把它当顶层，不该悄悄改写成"没有父会话"）。
      ...resolveParentField(this.currentParentSessionId ?? existing?.parentSessionId),
      turnState: this.currentTurnState,
      snapshot: {
        ...toPersistedSnapshot(snapshot, conversationMessages),
        displayUsage: resolveDisplayUsage(options.displayUsage, existing?.snapshot.displayUsage, snapshot.lastUsage),
      },
    };
    // If the turn-state already changed, the persisted document is definitely
    // different, so skip the expensive full-session equality JSON comparison
    // (which stringifies both sides) and go straight to the write. This keeps a
    // large active session from being serialized several times per turn.
    const stateChanged = existing?.turnState !== this.currentTurnState;
    if (existing && !stateChanged && sessionsEqual(existing, session)) {
      this.currentPersistedSignature = sessionSignature(existing);
      return true;
    }
    session.revision = (existing?.revision ?? 0) + 1;
    session.updatedAt = now;
    this.store.save(session);
    this.currentPersistedSignature = sessionSignature(session);
    return true;
  }

  /**
   * 改名并立即落盘。
   *
   * `source: 'auto'` 是插件（例如自动重命名会话）用的：用户手动改过标题之后，自动来源
   * 一律被拒——机器生成的标题不能覆盖用户明确写下的东西。返回 false 表示这次没改。
   */
  renameCurrent(title: string, options: { source?: 'manual' | 'auto' } = {}): boolean {
    const source = options.source ?? 'manual';
    const nextTitle = normalizeSessionTitle(title);
    if (!nextTitle) return false;
    if (source === 'auto' && this.currentTitleSource === 'manual') return false;

    const now = new Date().toISOString();
    this.currentTitleOverride = nextTitle;
    this.currentTitleSource = source;

    const existing = this.store.load(this.currentSessionId);
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = getPersistableConversationMessages(this.agent);
    const session: PersistedSession = {
      version: 1,
      revision: (existing?.revision ?? 0) + 1,
      id: this.currentSessionId,
      title: nextTitle,
      titleSource: source,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      cwd: process.cwd(),
      ...resolveParentField(this.currentParentSessionId ?? existing?.parentSessionId),
      turnState: existing?.turnState ?? this.currentTurnState,
      snapshot: existing?.snapshot ?? toPersistedSnapshot(snapshot, conversationMessages),
    };
    this.store.save(session);
    this.currentPersistedSignature = sessionSignature(session);
    return true;
  }

  getCurrentTitle(): string | null {
    return this.currentTitleOverride;
  }

  getCurrentTitleSource(): 'derived' | 'auto' | 'manual' {
    return this.currentTitleSource;
  }

  /** 当前对外展示的标题：覆盖值优先，否则用最近一次保存的标题。 */
  getCurrentDisplayTitle(): string {
    return this.currentTitleOverride ?? this.store.load(this.currentSessionId)?.title ?? 'Untitled session';
  }

  getCurrentSessionId(): string {
    return this.currentSessionId;
  }

  /**
   * 落盘那份会话里已有多少条对话。
   *
   * 用来发现「内存里是空的、文件里却有历史」这种不一致：宿主在某些路径上会直接
   * 存一次（插件面板动作改会话级状态），如果 resume 没成功把历史装进 agent，
   * 这一次存盘就会把用户的历史整段抹掉。
   */
  persistedConversationCount(): number {
    const session = this.store.load(this.currentSessionId);
    if (!session) return 0;
    return getPersistedConversationMessages(session.snapshot).length;
  }

  resume(id: string): ResumeSessionResult {
    const session = this.store.load(id);
    if (!session) return { ok: false, message: `Session not found: ${id}` };

    return this.resumeLoaded(session);
  }

  /**
   * 会话当前的对话记录（UI 视角）。
   *
   * 读落盘快照里的 `conversationMessages`，而不是 provider history：compact 会把历史改写成
   * 摘要、history normalizer 也会按协议丢掉不认识的消息，而用户眼前仍是原文。刚恢复的会话
   * 在进程里还没跑过轮次时，provider 那份更是空的——插件按它导出会得到一条空对话。
   * 只有还没落盘的新会话（含 `mica exec`）才退回内存里的那一份。
   */
  getConversationMessages(): MicaUiConversationMessage[] {
    const persisted = this.currentSessionId ? this.store.load(this.currentSessionId) : null;
    const fromDisk = persisted ? getPersistedConversationMessages(persisted.snapshot) : [];
    return fromDisk.length ? fromDisk : getPersistableConversationMessages(this.agent);
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
    this.currentParentSessionId = session.parentSessionId ?? null;
    this.currentPersistedSignature = sessionSignature(session);
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

  /** Reloads the active session when another process has changed its file. */
  refreshFromStore(): ResumeSessionResult | null {
    const session = this.store.load(this.currentSessionId);
    if (!session || sessionSignature(session) === this.currentPersistedSignature) return null;
    return this.resumeLoaded(session);
  }

  /**
   * Loads the current session once and reports whether another process changed
   * it, without resuming. Used by the idle external-session poller so it can
   * skip the expensive full load on every tick; only a real external change is
   * resumed via {@link resumeLoaded}.
   */
  peekExternalChange(): { session: PersistedSession; changed: boolean } | null {
    const session = this.store.load(this.currentSessionId);
    if (!session) return null;
    return { session, changed: sessionSignature(session) !== this.currentPersistedSignature };
  }

  private discardCurrentIfEmpty(): boolean {
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = getPersistableConversationMessages(this.agent);
    if (hasConversation(snapshot.messages, conversationMessages)) return false;
    // 用户亲手起过名字的空会话不是草稿：重命名就是「这条会话要留下」的表达。
    // 换会话时把它删掉，侧栏里那条刚命名好的会话就会凭空消失。
    if (this.currentTitleSource === 'manual') return false;
    return this.store.delete(this.currentSessionId);
  }
}

function sessionsEqual(left: PersistedSession, right: PersistedSession): boolean {
  return JSON.stringify(stripDerivedContextWindow(left)) === JSON.stringify(stripDerivedContextWindow(right));
}

/**
 * `snapshot.contextWindowSize` is derived from the model rule at save time,
 * so older snapshots lack it and async model-rule loads can change it. It
 * must not make an otherwise unchanged resumed session get rewritten (which
 * bumps revision and refreshes updatedAt).
 */
function stripDerivedContextWindow(session: PersistedSession): PersistedSession {
  if (session.snapshot.contextWindowSize === undefined) return session;
  return { ...session, snapshot: { ...session.snapshot, contextWindowSize: undefined } };
}

function sessionSignature(session: PersistedSession): string {
  return JSON.stringify(session);
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

/** 父会话 id 只接受非空字符串；其余（`undefined` / 空串 / 自己）一律当没有。 */
function normalizeParentSessionId(value: string | null | undefined): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id || null;
}

/** 落盘时只在有父会话时写这个键：没有就整条不出现，老会话的读法不受影响。 */
function resolveParentField(parentSessionId: string | null | undefined): { parentSessionId?: string } {
  const id = normalizeParentSessionId(parentSessionId);
  return id ? { parentSessionId: id } : {};
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

/**
 * compact 后的上下文占用只用于展示：`lastUsage` / `usageHistory` 继续作为
 * Stats 的对账口径保持不动，所以压缩结果单独存一份。一旦出现更晚的真实
 * 用量记录（下一次模型请求）就丢弃它，避免盖住新值。
 */
function resolveDisplayUsage(
  requested: PersistedSnapshotDisplayUsage | undefined,
  existing: PersistedSnapshotDisplayUsage | undefined,
  lastUsage: AgentRuntimeSnapshot['lastUsage'],
): PersistedSnapshotDisplayUsage | undefined {
  if (requested) return requested;
  if (!existing) return undefined;
  const occurredAt = lastUsage?.occurredAt;
  if (!occurredAt) return existing;
  return existing.compactedAt > occurredAt ? existing : undefined;
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
    capabilitySelection: snapshot.capabilitySelection,
    // 只在定制过时写这个键：`parsePersistedSession` 把非 true 归一成 undefined，
    // 若这里写 `false`，磁盘上是 `false`、读回来是 undefined，`sessionSignature`
    // 每轮都对不上，于是每个 turn 都会误判「别的进程改过」而整份 resume 一次
    // （turn/start 刚应用的 role 会被快照里的旧角色盖回去）。
    ...(snapshot.capabilitiesCustomized ? { capabilitiesCustomized: true } : {}),
    pluginState: snapshot.pluginState,
    pluginSessionSettings: snapshot.pluginSessionSettings,
    contextWindowSize: micaConfig.getModelRule(snapshot.model, { id: snapshot.providerId }).contextSize,
    messages: snapshot.messages,
    conversationMessages,
    usageHistory: snapshot.usageHistory,
    lastUsage: snapshot.lastUsage,
    subagentUsageHistory: snapshot.subagentUsageHistory,
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
    capabilitySelection: snapshot.capabilitySelection,
    capabilitiesCustomized: snapshot.capabilitiesCustomized,
    pluginState: snapshot.pluginState,
    pluginSessionSettings: snapshot.pluginSessionSettings,
    messages: snapshot.messages,
    usageHistory: snapshot.usageHistory,
    lastUsage: snapshot.lastUsage,
    subagentUsageHistory: snapshot.subagentUsageHistory,
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
    const provider =
      snapshotProvider ?? config.providers.find((item) => item.id === config.provider) ?? config.providers[0];
    if (!provider) return config;

    const snapshotModelAvailable = providerSupportsModel(provider, snapshot.model);
    const model =
      snapshotProvider && snapshotModelAvailable
        ? snapshot.model
        : provider.id === config.provider && providerSupportsModel(provider, config.model)
          ? config.model
          : (provider.models?.[0] ?? snapshot.model);
    const effort =
      provider.supportsEffort === false ? 'none' : micaConfig.normalizeModelEffort(model, snapshot.effort, provider);
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
      contextWindowSize: micaConfig.getModelRule(model, provider).contextSize,
    };
  });
  return resolvedSnapshot;
}

function deriveTitle(messages: MicaUiConversationMessage[]): string {
  // The title tracks what the session is currently about, so it follows the
  // most recent user prompt instead of the first one.
  const lastUserMessage = messages.findLast(isTitleUserMessage);
  const text = lastUserMessage ? contentToText(lastUserMessage.content) : '';
  // 图片占位符（`[Image](路径)`）只属于输入原文，标题里留着会变成一串本地路径。
  const title = stripMediaPlaceholders(text).replace(/\s+/g, ' ').trim();
  if (!title) return 'Untitled session';
  return title.length > 60 ? `${title.slice(0, 57)}...` : title;
}

function isTitleUserMessage(message: MicaUiConversationMessage): boolean {
  if (message.role !== 'user') return false;
  if (isInjectedUserMessage(message)) return false;
  const text = contentToText(message.content).trimStart();
  return !isInternalCompactText(text);
}

/**
 * Plugin-injected prompts are submitted with a `displayText`, so their
 * `displayContent` differs from the real wire content. They are not user input
 * and must never become the title.
 */
function isInjectedUserMessage(message: MicaUiConversationMessage): boolean {
  if (message.displayContent === undefined) return false;
  return contentToText(message.displayContent).trim() !== contentToText(message.content).trim();
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
