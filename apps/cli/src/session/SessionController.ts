import { micaUi } from '@packages/mica-ui/index.js';
import {
  DEFAULT_ROLE_NAME,
  calculateCachedTokenRate,
  type AgentUsageRecord,
  type SubagentUsageRecord,
} from '@packages/mica-agent/index.js';
import type { MicaUiCommandStatus, MicaUiConversationMessage, MicaUiTextBlock } from '@packages/mica-ui/index.js';
import { AgentRuntime, type AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import { micaConfig, providerSupportsModel } from '@packages/mica-config/index.js';
import {
  micaSession,
  takeLastSerializedSession,
  type PersistedRuntimeSnapshot,
  type PersistedSession,
  type PersistedSnapshotDisplayUsage,
  type PersistedSessionTurnState,
  type SessionStoreLike,
  type SessionSummary,
  type SessionTurnLease,
} from '@packages/mica-session/index.js';
import { getActiveContext } from '../app/activeContext.js';
import { micaContext } from '@packages/mica-context/index.js';
import { stripMediaPlaceholders } from '@packages/mica-common/promptText.js';
import { bindTodoSessionOwner } from '@packages/mica-common/todoState.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ApplicationContext } from '../app/ApplicationContext.js';

export type ResumeSessionResult =
  | { ok: true; session: PersistedSession; roleFallback?: { missing: string; fallback: string } }
  | { ok: false; message: string };

export type SessionAgentAdapter = {
  getSnapshot(): AgentRuntimeSnapshot;
  loadSnapshot(snapshot: AgentRuntimeSnapshot, options?: { recoverActiveThinking?: boolean }): void;
  readonly events?: Pick<AgentRuntime['events'], 'on'>;
  reloadConfig(resetSession?: boolean): void;
  /** 可选：用户显式改能力（`/capabilities`）。标记为会话定制，之后不再跟随默认值。 */
  setCapabilities?(selection: NonNullable<AgentRuntimeSnapshot['capabilitySelection']>): unknown;
  /** 可选：`/clear`、`/new` 之后回到「跟随 config 默认值」的新会话状态。 */
  resetCapabilitiesToDefaults?(): unknown;
  /** 可选：`/clear`、`/new` 之后清空插件在会话里的状态（含会话笔记）。 */
  clearSession?(): void;
  recordSubagentUsage?(record: SubagentUsageRecord): void;
  readonly isRunning?: boolean;
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
  /** 这条会话正在等用户做一个选择（插件的 `ctx.ask`）；答案回来即清。 */
  private currentAwaitingInput: string | null = null;
  /** 这条会话派生自哪条会话；resume 时从文件读回来，新会话由调用方给。 */
  private currentParentSessionId: string | null = null;
  /**
   * 这个进程刚刚给当前会话指定了父会话、还没写进盘。
   *
   * 会话树在桌面端是直接改盘的（拖拽写 `parentSessionId`），而常驻宿主内存里那份
   * 是加载时的旧值：一直用它回写，用户刚拖出来的层级会被下一次保存悄悄撤销。
   * 所以只有「本进程新建、还没落盘」的那一次以内存为准，之后一律跟随盘上的值。
   */
  private parentSessionOwned = false;
  private currentPersistedSignature: string | null = null;
  private currentFileSignature: string | null = null;
  private currentPersistedCwd: string | null = null;
  private currentSessionHasBeenPersisted = false;
  private recoveredActiveThinkingSignature: string | null = null;
  /** Only handles acquired by this controller confer ownership, even within one process. */
  private readonly turnLeases = new Map<string, SessionTurnLease>();
  private todoPersistenceEnabled = true;
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
    bindTodoSessionOwner(this.agent, () => ({ id: this.currentSessionId, persistent: this.todoPersistenceEnabled }));
    this.agent.events?.on('thinkingCheckpoint', () => this.saveThinkingProgress());
    this.agent.events?.on('textRollback', () => this.saveThinkingProgress());
  }

  /** A no-save executor must not create or change the todo checkpoint either. */
  setTodoPersistenceEnabled(enabled: boolean): void {
    this.todoPersistenceEnabled = enabled;
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

  /** Acquire before refresh/run; releasing the handle also clears this controller's ownership. */
  acquireTurnLease(): SessionTurnLease | null {
    const sessionId = this.currentSessionId;
    if (this.getHeldTurnLease(sessionId)) return null;
    const acquired = micaSession.acquireTurnLease(sessionId);
    if (!acquired) return null;
    const lease: SessionTurnLease = {
      sessionId,
      isHeld: () => acquired.isHeld(),
      release: () => {
        if (this.turnLeases.get(sessionId) === lease) this.turnLeases.delete(sessionId);
        acquired.release();
      },
    };
    this.turnLeases.set(sessionId, lease);
    return lease;
  }

  private getHeldTurnLease(sessionId: string): SessionTurnLease | null {
    const lease = this.turnLeases.get(sessionId);
    if (!lease) return null;
    if (lease.isHeld()) return lease;
    lease.release();
    return null;
  }

  /**
   * Charge the captured session, borrowing only our own live turn's lease. A
   * different writer (including another controller in this PID) must finish
   * first. The latest disk snapshot supplies everything except the new usage;
   * the idle agent's conversation or a pre-rewind history is never written back.
   */
  async recordSubagentUsageForSession(sessionId: string, record: SubagentUsageRecord): Promise<boolean> {
    let acquired: SessionTurnLease | null = null;
    while (!this.getHeldTurnLease(sessionId)) {
      acquired = micaSession.acquireTurnLease(sessionId);
      if (acquired) break;
      // Deletion also cancels a pending charge; it must not recreate a session.
      if (!(this.store.statSignature ? this.store.statSignature(sessionId) : this.store.load(sessionId))) return false;
      if (sessionId === this.currentSessionId) this.currentSessionHasBeenPersisted = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    try {
      const session = this.store.load(sessionId);
      if (!session) {
        // A request may be the first activity in a brand-new local draft. Only
        // that draft may be created; a previously persisted/deleted session may
        // not. Keep the normal snapshot path limited to this first save.
        if (
          sessionId !== this.currentSessionId ||
          this.currentSessionHasBeenPersisted ||
          !this.agent.recordSubagentUsage
        ) {
          return false;
        }
        this.agent.recordSubagentUsage(record);
        return this.saveCurrent({ allowEmpty: true });
      }
      const saved: PersistedSession = {
        ...session,
        revision: (session.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        snapshot: {
          ...session.snapshot,
          subagentUsageHistory: [...(session.snapshot.subagentUsageHistory ?? []), record],
        },
      };
      const matchesBaseline =
        sessionId === this.currentSessionId && sessionSignature(session) === this.currentPersistedSignature;
      this.store.save(saved);
      if (sessionId === this.currentSessionId) {
        this.currentSessionHasBeenPersisted = true;
        // Keep the live turn's next checkpoint in sync without reloading its
        // messages or unioning disk usage into an intentional rewind. When
        // another writer changed the baseline, leave its signature outstanding
        // so the next leased refresh loads that writer's complete history.
        this.agent.recordSubagentUsage?.(record);
        if (matchesBaseline) {
          this.currentPersistedSignature = sessionSignature(saved);
          this.currentFileSignature = null;
        }
      }
      return true;
    } finally {
      acquired?.release();
    }
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
    this.parentSessionOwned = this.currentParentSessionId !== null;
    // 能力开关属于会话，不属于 agent：新会话重新跟随 config 里的默认值（不继承
    // 上一条会话关掉的工具，也不继承它的「已定制」状态）。
    this.agent.resetCapabilitiesToDefaults?.();
    // 插件状态同样属于会话：新会话从空白开始，不继承上一轮攒下的结论（笔记等）。
    this.agent.clearSession?.();
    this.currentTitleOverride = null;
    this.currentTitleSource = 'derived';
    this.currentTurnState = 'completed';
    this.currentAwaitingInput = null;
    this.currentPersistedSignature = null;
    this.recoveredActiveThinkingSignature = null;
    this.currentFileSignature = null;
    this.currentPersistedCwd = null;
    this.currentSessionHasBeenPersisted = false;
  }

  /** 当前会话的父会话 id（没有则为 null）。 */
  getParentSessionId(): string | null {
    return this.currentParentSessionId;
  }

  /**
   * 这条会话该写进盘里的父会话字段。
   *
   * 本进程新建的那一次以内存为准（盘上还没有）；其余情况跟随盘上的值，包括盘上
   * 明确没有父会话——那是用户在侧栏里改过的结果，不能被内存里的旧值顶回去。
   * 父会话被删掉之后仍保留这条线索（指向不存在的 id 只是让侧栏把它当顶层）。
   */
  private parentFieldFor(existing: PersistedSession | null | undefined): { parentSessionId?: string } {
    if (this.parentSessionOwned) return resolveParentField(this.currentParentSessionId);
    return resolveParentField(existing ? existing.parentSessionId : this.currentParentSessionId);
  }

  saveCurrent(
    options: {
      allowEmpty?: boolean;
      turnState?: PersistedSessionTurnState;
      /** 「在等你选」那句话；不传就沿用内存里那份（清理由 `setAwaitingInput(null)` 负责）。 */
      awaitingInput?: string | null;
      preserveTitle?: boolean;
      conversationMessages?: MicaUiConversationMessage[];
      /** 压缩后的上下文占用，仅供界面展示（见 resolveDisplayUsage）。 */
      displayUsage?: PersistedSnapshotDisplayUsage;
    } = {},
  ): boolean {
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = options.conversationMessages ?? getPersistableConversationMessages(this.agent);
    this.currentTurnState = options.turnState ?? this.currentTurnState;
    if (options.awaitingInput !== undefined) this.currentAwaitingInput = options.awaitingInput;
    // 轮次真的结束了就不该还挂着「等你选」：它是那一轮停在中途的标记，进程也可能
    // 是在别处收尾的（这一轮被中断、下一轮由另一个宿主接上）。
    //
    // 只清「顺手带过去」的那份：显式传 `awaitingInput` 的调用方（`setAwaitingInput`）
    // 自己负责这件事——提问发生在工具执行期，那一刻这一轮还没写出过任何东西，
    // `currentTurnState` 仍是上一次的 completed，照这里清就会把刚做的标记立刻抹掉。
    if (
      options.awaitingInput === undefined &&
      (this.currentTurnState === 'completed' || this.currentTurnState === 'error')
    ) {
      this.currentAwaitingInput = null;
    }
    const hasContent = hasConversation(snapshot.messages, conversationMessages);
    if (!hasContent && !hasUsage(snapshot) && !options.allowEmpty && this.currentTitleSource !== 'manual') {
      this.store.delete(this.currentSessionId);
      // The file is gone, so the recorded signature no longer describes
      // anything on disk. Clearing it keeps the next save (this session is
      // still the live one) from being treated as "another writer owns it".
      this.currentPersistedSignature = null;
      this.currentFileSignature = null;
      return false;
    }

    // `allowEmpty` 是「草稿也存一份」，不是「允许把已有历史写空」：resume 没把历史装进
    // agent 的进程（插件面板动作、能力开关这类不跑 turn 的入口）如果照原样存，
    // 用户几百条对话会被一次点击抹掉。宁可这次不落盘。
    const existing = this.store.load(this.currentSessionId);
    if (existing) this.currentSessionHasBeenPersisted = true;
    if (
      options.allowEmpty &&
      !hasContent &&
      existing &&
      getPersistedConversationMessages(existing.snapshot).length > 0
    ) {
      return false;
    }

    const now = new Date().toISOString();
    if (this.currentPersistedSignature !== null && !existing) {
      // The file was removed underneath us (another process, or our own empty
      // save above) while this session stayed the live one. Returning early
      // would turn every later save of this process into a silent no-op and
      // lose the whole conversation at the next unexpected termination, so
      // forget the stale signature and write again.
      this.currentPersistedSignature = null;
      this.currentFileSignature = null;
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
      ...this.parentFieldFor(existing),
      turnState: this.currentTurnState,
      ...(this.currentAwaitingInput ? { awaitingInput: this.currentAwaitingInput } : {}),
      snapshot: {
        ...toPersistedSnapshot(snapshot, conversationMessages),
        ...(this.currentTurnState === 'running' ? {} : { activeThinking: undefined, activeTurn: undefined }),
        displayUsage: resolveDisplayUsage(options.displayUsage, existing?.snapshot.displayUsage, snapshot.lastUsage),
      },
    };
    const unchangedSignature = existing ? matchingSessionSignature(existing, session) : null;
    if (existing && unchangedSignature !== null) {
      this.currentPersistedSignature = unchangedSignature;
      this.currentPersistedCwd = existing.cwd;
      this.currentFileSignature = null;
      return true;
    }
    session.revision = (existing?.revision ?? 0) + 1;
    session.updatedAt = now;
    this.store.save(session);
    this.currentSessionHasBeenPersisted = true;
    this.parentSessionOwned = false;
    this.currentParentSessionId = session.parentSessionId ?? null;
    this.currentPersistedSignature = sessionSignature(session);
    this.currentPersistedCwd = session.cwd;
    this.currentFileSignature = null;
    return true;
  }

  /**
   * 标记 / 清除「这条会话正在等用户做一个选择」，并立刻落盘。
   *
   * 侧栏读的是会话文件，所以这件事必须落到盘上：「用户正待在别的会话里」正是它要提醒
   * 的场景，进程内经不起一次切换，更经不起重启。轮次收尾时 `saveCurrent` 会按
   * `turnState` 自行清掉，这里只负责在问题出现/消失的那一刻先把文件改对。
   */
  setAwaitingInput(text: string | null): void {
    const next = typeof text === 'string' && text.trim() ? text.trim() : null;
    if (this.currentAwaitingInput === next) return;
    this.currentAwaitingInput = next;
    // 直接改盘上那一份的这一个字段，不走完整保存：完整保存要先过「还没有对话内容就
    // 别落盘」的保护，而提问恰好发生在第一个答案之前，标记会被那条保护一起挡掉。
    // 文件被改动之后，之前记下的签名不再描述它，下一次保存据此重新写一份完整快照。
    if (this.store.patchAwaitingInput?.(this.currentSessionId, next)) {
      this.currentSessionHasBeenPersisted = true;
      this.currentPersistedSignature = null;
      this.currentFileSignature = null;
    }
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
      ...this.parentFieldFor(existing),
      turnState: existing?.turnState ?? this.currentTurnState,
      // 改名不该顺手把「在等你选」抹掉：它描述的那一轮还在跑。
      ...(this.currentAwaitingInput ? { awaitingInput: this.currentAwaitingInput } : {}),
      snapshot: existing?.snapshot ?? toPersistedSnapshot(snapshot, conversationMessages),
    };
    this.store.save(session);
    this.currentSessionHasBeenPersisted = true;
    this.parentSessionOwned = false;
    this.currentParentSessionId = session.parentSessionId ?? null;
    this.currentPersistedSignature = sessionSignature(session);
    this.currentPersistedCwd = session.cwd;
    this.currentFileSignature = null;
    return true;
  }

  getCurrentTitle(): string | null {
    return this.currentTitleOverride;
  }

  /**
   * 切换当前会话的工作目录。
   *
   * 会话文件里的 cwd 取自 `process.cwd()`——每一次保存都会重新写它。所以切目录不能只
   * 改盘上那个字段：宿主进程还站在旧目录里，下一轮保存会把旧值写回去，而那一轮的工具
   * 和 prompt 里的 cwd 也还是旧的。这里真的 chdir，再按新目录把已落盘的那份改过来，
   * 于是「下一轮生效」和「保存一致」是同一件事。
   *
   * `updatedAt` 与 `turnState` 都不动：换项目目录不是会话活动，动 updatedAt 会把会话
   * 顶到 Recent 最前面。返回 false 表示这条会话还没落过盘（新对话），没有文件可改。
   */
  setCurrentCwd(dir: string): boolean {
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const existing = this.store.load(this.currentSessionId);
      if (!existing) return false;
      this.currentSessionHasBeenPersisted = true;
      const cwd = process.cwd();
      if (existing.cwd === cwd) return true;
      const saved: PersistedSession = {
        ...existing,
        cwd,
        revision: (existing.revision ?? 0) + 1,
      };
      this.store.save(saved);
      this.currentPersistedSignature = sessionSignature(saved);
      this.currentPersistedCwd = saved.cwd;
      this.currentFileSignature = null;
      return true;
    } catch (error) {
      process.chdir(previousCwd);
      throw error;
    }
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
    return this.restoreLoaded(session, false);
  }

  private restoreLoaded(session: PersistedSession, leaseHeld: boolean): ResumeSessionResult {
    if (this.agent.isRunning) return { ok: false, message: 'Cannot resume a session while the agent is running' };
    // A running snapshot may belong to a live writer. Take the same lease as
    // turns do, then re-read under the lease before recovering its checkpoint.
    // refreshFromStore is called by a turn that already holds that lease.
    const lease =
      !leaseHeld && session.turnState === 'running' && (session.snapshot.activeThinking || session.snapshot.activeTurn)
        ? micaSession.acquireTurnLease(session.id)
        : null;
    try {
      if (lease) {
        const current = this.store.load(session.id);
        if (!current) return { ok: false, message: `Session not found: ${session.id}` };
        session = current;
      }
      return this.applyLoadedSession(session, leaseHeld || Boolean(lease));
    } finally {
      lease?.release();
    }
  }

  private applyLoadedSession(session: PersistedSession, leaseHeld: boolean): ResumeSessionResult {
    // Follow a cwd changed by another writer when reloading the current
    // session. A first resume may deliberately use an explicit startup cwd.
    const previousCwd = this.currentPersistedCwd ?? undefined;
    if (
      session.id === this.currentSessionId &&
      previousCwd !== undefined &&
      session.cwd !== previousCwd &&
      session.cwd
    ) {
      try {
        process.chdir(session.cwd);
      } catch {
        // The project may have been removed; still restore its conversation.
      }
    }
    if (session.id !== this.currentSessionId) this.discardCurrentIfEmpty();
    const requestedRole = session.snapshot.role ?? DEFAULT_ROLE_NAME;
    const restoredRole = resolveSnapshotRole(requestedRole);
    const resolvedSnapshot = this.config.apply(session.snapshot) ?? session.snapshot;
    this.agent.reloadConfig(false);
    const recoverActiveThinking =
      leaseHeld &&
      session.turnState === 'running' &&
      Boolean(resolvedSnapshot.activeThinking || resolvedSnapshot.activeTurn);
    const runtimeSnapshot = fromPersistedSnapshot(resolvedSnapshot, restoredRole);
    if (recoverActiveThinking) this.agent.loadSnapshot(runtimeSnapshot, { recoverActiveThinking: true });
    else this.agent.loadSnapshot(runtimeSnapshot);
    this.currentSessionId = session.id;
    this.currentSessionHasBeenPersisted = true;
    this.currentTurnState = session.turnState ?? 'completed';
    // 恢复时照原样带着：真问题可能还在等（宿主刚刚崩过），下一个 `saveCurrent` 会
    // 按 `turnState` 决定要不要留下它。
    this.currentAwaitingInput = session.awaitingInput ?? null;
    this.currentParentSessionId = session.parentSessionId ?? null;
    this.parentSessionOwned = false;
    this.currentPersistedSignature = sessionSignature(session);
    this.currentPersistedCwd = session.cwd;
    this.currentFileSignature = null;
    this.recoveredActiveThinkingSignature = recoverActiveThinking ? this.currentPersistedSignature : null;
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

  /**
   * Reloads external changes before a turn. A persistent turn must already hold
   * its session lease; read-only executors probe the lease themselves.
   */
  refreshFromStore(): ResumeSessionResult | null {
    if (this.agent.isRunning) return null;
    const heldLease = this.getHeldTurnLease(this.currentSessionId);
    const session = this.store.load(this.currentSessionId);
    if (!session) return null;
    const signature = sessionSignature(session);
    if (
      signature === this.currentPersistedSignature &&
      (session.turnState !== 'running' ||
        (!session.snapshot.activeThinking && !session.snapshot.activeTurn) ||
        signature === this.recoveredActiveThinkingSignature)
    )
      return null;
    if (heldLease) return this.restoreLoaded(session, true);
    // Callers outside a persistent turn do not hold a lease. Avoid refreshing a
    // live writer's snapshot; read it again once we can own the lease ourselves.
    const lease = micaSession.acquireTurnLease(session.id);
    if (!lease) return null;
    try {
      const current = this.store.load(session.id);
      return current ? this.restoreLoaded(current, true) : null;
    } finally {
      lease.release();
    }
  }

  /** Save the display checkpoint and the matching provider history for recovery. */
  private saveThinkingProgress(): void {
    if (!this.todoPersistenceEnabled || !this.agent.isRunning || this.currentTurnState !== 'running') return;
    const existing = this.store.load(this.currentSessionId);
    if (!existing || existing.turnState !== 'running') return;
    const current = this.agent.getSnapshot();
    const { activeThinking, activeTurn, messages } = current;
    // Thinking changes much more often than the provider history. Compare the
    // small checkpoint fields first so a new part does not serialize all prior
    // messages merely to establish that it needs saving.
    if (
      jsonValuesEqual(activeThinking, existing.snapshot.activeThinking) &&
      jsonValuesEqual(activeTurn, existing.snapshot.activeTurn) &&
      jsonValuesEqual(messages, existing.snapshot.messages)
    )
      return;
    const { activeThinking: _oldThinking, activeTurn: _oldTurn, ...snapshot } = existing.snapshot;
    const session: PersistedSession = {
      ...existing,
      revision: (existing.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      snapshot: {
        ...snapshot,
        messages,
        ...(activeThinking ? { activeThinking } : {}),
        ...(activeTurn ? { activeTurn } : {}),
      },
    };
    this.store.save(session);
    this.currentPersistedSignature = sessionSignature(session);
    this.currentPersistedCwd = session.cwd;
    this.currentFileSignature = null;
  }

  /**
   * Stable idle polls only stat the file. On metadata changes, compare its
   * contents before asking the caller to resume it.
   */
  peekExternalChange(): { session: PersistedSession; changed: boolean } | null {
    const before = this.store.statSignature?.(this.currentSessionId) ?? null;
    if (before && before === this.currentFileSignature) return null;
    const session = this.store.load(this.currentSessionId);
    if (!session) {
      this.currentFileSignature = null;
      return null;
    }
    const after = this.store.statSignature?.(this.currentSessionId) ?? null;
    // A replacement during the read may have supplied an older inode.
    if (before !== after) {
      this.currentFileSignature = null;
      return null;
    }
    const changed = sessionSignature(session) !== this.currentPersistedSignature;
    this.currentFileSignature = changed ? null : after;
    return { session, changed };
  }

  private discardCurrentIfEmpty(): boolean {
    const snapshot = this.agent.getSnapshot();
    const conversationMessages = getPersistableConversationMessages(this.agent);
    if (hasConversation(snapshot.messages, conversationMessages)) return false;
    if (hasUsage(snapshot)) return false;
    // 用户亲手起过名字的空会话不是草稿：重命名就是「这条会话要留下」的表达。
    // 换会话时把它删掉，侧栏里那条刚命名好的会话就会凭空消失。
    if (this.currentTitleSource === 'manual') return false;
    return this.store.delete(this.currentSessionId);
  }
}

function matchingSessionSignature(left: PersistedSession, right: PersistedSession): string | null {
  // A new iteration normally appends messages or usage. These cheap, definite
  // differences avoid serializing two complete long sessions before the write.
  if (
    left.turnState !== right.turnState ||
    left.title !== right.title ||
    left.titleSource !== right.titleSource ||
    left.cwd !== right.cwd ||
    left.parentSessionId !== right.parentSessionId ||
    left.awaitingInput !== right.awaitingInput ||
    left.snapshot.messages.length !== right.snapshot.messages.length ||
    left.snapshot.conversationMessages.length !== right.snapshot.conversationMessages.length ||
    left.snapshot.usageHistory.length !== right.snapshot.usageHistory.length ||
    left.snapshot.subagentUsageHistory?.length !== right.snapshot.subagentUsageHistory?.length
  )
    return null;

  const comparableLeft = stripDerivedContextWindow(left);
  const comparableRight = stripDerivedContextWindow(right);
  // Parsed sessions and runtime snapshots use different sets of optional keys.
  // Ignore undefined keys at these two schema levels, just as JSON does. Native
  // structural equality avoids allocating full JSON strings in the common no-op
  // case; the fallback retains JSON semantics for nested optional values.
  const normalizedLeft = omitUndefinedFields({
    ...comparableLeft,
    snapshot: omitUndefinedFields(comparableLeft.snapshot),
  });
  const normalizedRight = omitUndefinedFields({
    ...comparableRight,
    snapshot: omitUndefinedFields(comparableRight.snapshot),
  });
  if (isDeepStrictEqual(normalizedLeft, normalizedRight)) return sessionSignature(left);
  const comparable = JSON.stringify(comparableLeft);
  if (comparable !== JSON.stringify(comparableRight)) return null;
  const json = left.snapshot.contextWindowSize === undefined ? comparable : JSON.stringify(left);
  return createHash('sha256').update(json).digest('hex');
}

function omitUndefinedFields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right) || JSON.stringify(left) === JSON.stringify(right);
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
  // 刚 `save()` 过的那个对象，写出去的那份紧凑 JSON 就是 `JSON.stringify(session)`：
  // 直接拿它算签名，省掉一次整份序列化（20MB 会话约 16–20ms，每个请求边界都走一次）。
  // 从磁盘读回来的会话没有这份交接，退回正常路径。
  const json = takeLastSerializedSession(session) ?? JSON.stringify(session);
  return createHash('sha256').update(json).digest('hex');
}

function hasConversation(providerMessages: unknown[], conversationMessages: MicaUiConversationMessage[]): boolean {
  if (conversationMessages.some((message) => message.role === 'user' || message.role === 'assistant')) return true;
  return providerMessages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const role = (message as { role?: unknown }).role;
    return role === 'user' || role === 'assistant';
  });
}

function hasUsage(snapshot: AgentRuntimeSnapshot): boolean {
  return snapshot.usageHistory.length > 0 || (snapshot.subagentUsageHistory?.length ?? 0) > 0;
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
    const interruptedThinking = agent.getSnapshot().interruptedThinking?.text;
    if (interruptedThinking) {
      micaUi.bottom.agentTurnLog.appendItem(micaUi.createThinkingLogItem('restored-thinking', interruptedThinking));
    }
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
    // 提示词不进对话历史，但属于会话事实：存最近一次请求真实发出去的那一份，界面据此
    // 展示完整内容（角色 + AGENT.md + skills + 插件段落），不必自己再拼一遍。
    ...(snapshot.systemPrompt ? { systemPrompt: snapshot.systemPrompt } : {}),
    messageFormat: snapshot.messageFormat,
    messages: snapshot.messages,
    conversationMessages,
    ...(snapshot.interruptedThinking ? { interruptedThinking: snapshot.interruptedThinking } : {}),
    ...(snapshot.activeThinking ? { activeThinking: snapshot.activeThinking } : {}),
    ...(snapshot.activeTurn ? { activeTurn: snapshot.activeTurn } : {}),
    usageHistory: snapshot.usageHistory,
    lastUsage: snapshot.lastUsage,
    subagentUsageHistory: snapshot.subagentUsageHistory,
    ...(snapshot.turnTimings?.length ? { turnTimings: snapshot.turnTimings } : {}),
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
    systemPrompt: snapshot.systemPrompt,
    messageFormat: snapshot.messageFormat,
    messages: snapshot.messages,
    usageHistory: snapshot.usageHistory,
    lastUsage: snapshot.lastUsage,
    interruptedThinking: snapshot.interruptedThinking,
    activeThinking: snapshot.activeThinking,
    activeTurn: snapshot.activeTurn,
    subagentUsageHistory: snapshot.subagentUsageHistory,
    turnTimings: snapshot.turnTimings,
  };
}

function resolveSnapshotRole(roleName?: string): string {
  return typeof roleName === 'string' && roleName.trim() ? roleName.trim() : DEFAULT_ROLE_NAME;
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
  // Compact rewrites model history so that it starts with synthetic user
  // messages. The UI conversation still contains the original prompt and is
  // therefore the authoritative title source when one is available.
  return fallbackMessages.some(isTitleUserMessage)
    ? fallbackMessages
    : sanitizeConversationMessages(agent.toConversationMessages());
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
      record.variant === 'digest' ||
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
