import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { deleteBtwState } from '@packages/mica-common/btwState.js';
import { stripMediaPlaceholders } from '@packages/mica-common/promptText.js';
import { readHeadString, readSessionFileHead } from './sessionFileHead.js';
import { normalizeTurnTimings, type TurnTimingRecord } from '@packages/mica-common/turnTiming.js';
import type { CapabilitySelection } from '@packages/mica-common/capabilities.js';
import type { AgentQueryContent, AgentUsageRecord, SubagentUsageRecord } from '@packages/mica-agent/index.js';
import {
  isEffortLevelName,
  isProviderProtocol,
  type EffortOption,
  type ProviderProtocol,
} from '@packages/mica-config/index.js';

export type PersistedRuntimeSnapshot = {
  providerId: string;
  protocol: ProviderProtocol;
  model: string;
  effort: EffortOption;
  role: string;
  /**
   * Per-session capability selection (skills / tools / MCP servers). Only used
   * when {@link capabilitiesCustomized} is true; otherwise the config defaults
   * (`config.json` `capabilityDefaults`) apply at runtime.
   */
  capabilitySelection?: CapabilitySelection;
  /**
   * True when the user changed capabilities inside this session, so it keeps its
   * own selection. Missing (including every session written before this flag
   * existed) means "follow the config defaults".
   */
  capabilitiesCustomized?: boolean;
  /**
   * 插件在本会话里的持久状态：插件 id → 插件自己的 JSON。
   *
   * 属于会话而不进对话历史：compact 改不到它，所以插件能把长期有效的内容（会话
   * 笔记、循环任务说明）留在 system prompt 里。缺失表示没有任何插件写过状态。
   */
  pluginState?: Record<string, unknown>;
  /**
   * 插件设置的会话级覆盖：插件 id → 该会话里改过的键。
   *
   * 与 `pluginState` 分开：这一份是用户对插件配置的显式选择，界面按字段渲染，
   * 插件自己不该有机会改写它。只存改过的键，其余继续跟随全局设置。
   */
  pluginSessionSettings?: Record<string, Record<string, string>>;
  /** Model context window in tokens; informational for the web console's
   *  context usage display. Optional so older snapshots parse cleanly. */
  contextWindowSize?: number;
  /** Context occupancy to display after a compact. Compacting deliberately keeps
   *  `lastUsage` / `usageHistory` untouched so Stats stays continuous, so the
   *  post-compact figure is stored separately and dropped as soon as a newer
   *  usage record exists. Display-only; optional for older snapshots. */
  displayUsage?: PersistedSnapshotDisplayUsage;
  /**
   * 最近一次请求实际发给模型的 system prompt 全文。
   *
   * 只用于展示与排查（配置页 / 桌面端的「系统提示词」页签）：它像上下文一样是现场拼出来的
   * ——角色提示词 + 项目说明 + skills 索引 + 环境信息 + 插件段落——只有把发出去的那一份
   * 存下来，界面才答得出「这次请求到底带了什么」。恢复会话不会拿它重建提示词，下一轮请求
   * 仍然重新拼装。缺失表示这条会话还没发过请求（或早于本字段出现）。
   */
  systemPrompt?: string;
  messages: unknown[];
  conversationMessages: unknown[];
  /** Completed display text from an interrupted Responses turn; never sent to the model. */
  interruptedThinking?: PersistedThinking;
  /** Completed display text in a running Responses turn. */
  activeThinking?: PersistedThinking;
  /** The input and its commit state relative to the saved provider messages. */
  activeTurn?: { input: AgentQueryContent; committed: boolean };
  usageHistory: AgentUsageRecord[];
  lastUsage: AgentUsageRecord | undefined;
  /** Subagent task usage appended by the Agent tool; optional for older snapshots. */
  subagentUsageHistory?: SubagentUsageRecord[];
  /**
   * 最近若干轮的时间去向（新的在后）。
   *
   * 属于会话事实：桌面端与会话详情页读的是它，而不是自己再算一遍。缺少表示这条
   * 会话还没有记录（早于本字段出现），界面如实说「没有记录」。
   */
  turnTimings?: TurnTimingRecord[];
};

type PersistedThinking = {
  providerId: string;
  protocol: ProviderProtocol;
  model: string;
  apiBase: string;
  text: string;
};

export type PersistedSnapshotDisplayUsage = {
  totalTokens: number;
  /** ISO time of the compact that produced `totalTokens`. */
  compactedAt: string;
};

export type PersistedSessionTurnState = 'running' | 'completed' | 'aborted' | 'error';

export type PersistedSession = {
  version: 1;
  revision?: number;
  id: string;
  title: string;
  titleSource?: 'derived' | 'auto' | 'manual';
  createdAt: string;
  updatedAt: string;
  cwd: string;
  /**
   * 这条会话是从哪条会话派生出来的（子会话 / fork）。
   *
   * 只用于展示与检索，不是权限或生命周期约束：父会话被删掉、被改名、正在
   * 另一个进程里跑，都不影响子会话能不能打开。侧栏据此把子会话挂到父会话
   * 下面，父会话不在当前列表里时子会话按顶层渲染。
   */
  parentSessionId?: string;
  turnState: PersistedSessionTurnState;
  /**
   * 这条会话正在等用户做一个选择（一句话，给侧栏看）；缺省表示没有在等。
   *
   * 「这一轮还没跑完」的附属信息：宿主在插件的工具等回答时写下，答案回来即清。
   * 侧栏据此在会话列表上提醒——即使用户正待在别的会话里。
   */
  awaitingInput?: string;
  snapshot: PersistedRuntimeSnapshot;
};

export type SessionSummary = {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  cwd: string;
  /** 派生自哪条会话，见 {@link PersistedSession.parentSessionId}。 */
  parentSessionId?: string;
  providerId: string;
  model: string;
  uncompleted: boolean;
  turnState?: PersistedSessionTurnState;
  effort?: EffortOption;
  role?: string;
  /** True when the persisted snapshot holds user/assistant conversation data.
   *  Carried on the summary so the list path can apply the junk rule (which
   *  must not hide a session that has content) without parsing session bodies. */
  hasConversation: boolean;
  /** True when the snapshot recorded model usage; a session that was already
   *  used for a request is never junk even if its title is still a placeholder. */
  hasUsage: boolean;
};

export type SessionStoreLike = {
  list(limit?: number): SessionSummary[];
  listRecent(limit?: number): SessionSummary[];
  listAllForUsage?(): PersistedSession[];
  load(id: string): PersistedSession | null;
  save(session: PersistedSession): void;
  /** 只改「正在等你选」这一个顶层标记（见实现里的说明）；文件不存在返回 false。 */
  patchAwaitingInput?(id: string, text: string | null): boolean;
  replaceValidated?(id: string, content: string): PersistedSession;
  delete(id: string): boolean;
};

export type SessionTurnLease = {
  sessionId: string;
  release(): void;
};

/**
 * 一个 sessions/*.json 里读不出摘要的文件（`version: 1` 之前的两种旧格式：裸
 * provider 消息数组，以及 `{id,title,updatedAt,messages}`）。它们不产生摘要，
 * 但仍占着一个文件，必须记进索引：否则 `indexMatchesDisk` 永远判「索引不完整」，
 * 每次 sessions/ 的 mtime 变化（等于每开一个新会话）都要全量重扫并解析整个目录。
 *
 * 存 size/mtime 是为了自愈——文件被改写或压缩过就重新尝试解析一次。
 */
type IndexReject = { id: string; size: number; mtimeMs: number };

type SessionIndex = { sessions: SessionSummary[]; rejects: IndexReject[] };

const MICA_HOME = resolveMicaHome();
export const SESSION_DIR = resolve(MICA_HOME, 'sessions');
const SESSION_INDEX_FILE = resolve(MICA_HOME, 'session-index.json');
/** v2 起索引还会记下「读不出摘要的文件」，见 {@link IndexReject}；v3 起摘要带
 * `parentSessionId`。版本对不上就整份重建——索引只是缓存，重建比逐条猜「这条
 * 摘要是不是旧版本写的」便宜得多。 */
const SESSION_INDEX_VERSION = 3;
const MALFORMED_LEASE_STALE_MS = 60_000;
// A session persistent without any conversation is a leftover from an
// allowEmpty turn-start save (see SessionController.saveCurrent) that never
// produced content before the process exited. It carries no user message, so
// deriveTitle falls back to this placeholder; we treat it as garbage and hide
// it from /resume (and delete the file on rebuild, except for running ones).
const UNTITLED_SESSION_TITLE = 'Untitled session';
/**
 * 会话跑久了几十上百 MB，每次迭代 checkpoint 都要整份 `JSON.stringify` + 落盘。缩进
 * 会让这份字符串多出三成字节，也就要多分配、多写三成——这个体量已经没人会手读。
 * 小会话仍写缩进格式（配置页 / 手工排查都好读），超过阈值改写成紧凑 JSON。
 */
const PRETTY_SESSION_MAX_BYTES = 2 * 1024 * 1024;

function serializeSession(session: PersistedSession): string {
  const compact = JSON.stringify(session);
  return compact.length <= PRETTY_SESSION_MAX_BYTES ? JSON.stringify(session, null, 2) : compact;
}

export class SessionStore implements SessionStoreLike {
  /** In-memory metadata summaries sorted by updatedAt descending. Lazily built. */
  private cachedIndex: SessionSummary[] | null = null;
  /** 与 cachedIndex 配套：读不出摘要的文件，见 {@link IndexReject}。 */
  private cachedRejects: IndexReject[] = [];
  /** Directory mtime when cachedIndex was built, so a session persisted by
   * another process (app-server / desktop runtime / another CLI) invalidates the cache. */
  private cachedIndexDirMtime = 0;

  list(limit = 20): SessionSummary[] {
    return this.ensureIndex()
      .filter((session) => !isJunkSummary(session))
      .slice(0, limit)
      .map((session) => ({ ...session }));
  }

  listRecent(limit = 20): SessionSummary[] {
    return this.ensureIndex()
      .filter((session) => !isJunkSummary(session))
      .slice(0, limit)
      .map((session) => ({ ...session }));
  }

  /** Reads current snapshots plus the legacy message-array format used by older Mica builds. */
  listAllForUsage(): PersistedSession[] {
    ensureSessionDir();
    return readdirSync(SESSION_DIR)
      .filter((file) => file.endsWith('.json') && file !== 'index.json' && file !== 'session-index.json')
      .map((file) => this.readForUsage(resolve(SESSION_DIR, file)))
      .filter((session): session is PersistedSession => Boolean(session));
  }

  load(id: string): PersistedSession | null {
    const safeId = sanitizeSessionId(id);
    if (!safeId) return null;
    return this.read(sessionPath(safeId));
  }

  save(session: PersistedSession): void {
    ensureSessionDir();
    const safeId = sanitizeSessionId(session.id);
    if (!safeId || safeId !== session.id) throw new Error(`Invalid session id: ${session.id}`);
    const path = sessionPath(safeId);
    const tmpPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${serializeSession(session)}\n`, 'utf-8');
    renameSync(tmpPath, path);
    try {
      this.updateIndexForSave(session);
    } catch {
      // best-effort metadata index; a rebuild reconciles it on the next list.
    }
  }

  /**
   * 只改「正在等你选」这一个顶层标记，其余内容原样写回。
   *
   * 标记必须进文件才能被侧栏读到（用户正待在别的会话里，进程内外都靠这份文件提醒）。
   * 它不能走完整保存：那次保存会先过「没有对话内容就别落盘」的保护，而提问恰好发生在
   * 第一个答案之前。键位置也刻意固定在 `snapshot` 之前——侧栏只读文件头 4KB，排在
   * 快照后面就永远看不到。
   *
   * 文件还不存在时返回 false：没有会话就没有那一行，标记留在内存里，下一次保存会带上。
   */
  patchAwaitingInput(id: string, text: string | null): boolean {
    const current = this.load(id);
    if (!current) return false;
    const { snapshot, ...rest } = current;
    const next: PersistedSession = { ...rest, ...(text ? { awaitingInput: text } : {}), snapshot };
    if (!text) delete next.awaitingInput;
    this.save(next);
    return true;
  }

  replaceValidated(id: string, content: string): PersistedSession {
    const safeId = sanitizeSessionId(id);
    if (!safeId || safeId !== id.trim()) throw new Error('Invalid session id');

    const current = this.load(safeId);
    if (!current) throw new Error(`Session not found: ${safeId}`);
    if (current.turnState === 'running') throw new Error(`Cannot replace running session: ${safeId}`);

    let data: unknown;
    try {
      data = JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`Invalid session JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const session = parsePersistedSession(data);
    if (!session) throw new Error('Invalid persisted session');
    if (session.id !== safeId) {
      throw new Error(`Session id mismatch: expected ${safeId}, received ${session.id}`);
    }
    if (session.turnState === 'running') throw new Error(`Cannot save running session: ${safeId}`);

    this.save(session);
    return session;
  }

  delete(id: string): boolean {
    const safeId = sanitizeSessionId(id);
    if (!safeId) return false;
    const path = sessionPath(safeId);
    if (!existsSync(path)) {
      // The session file is gone, so any lock for it is an orphan. Clear it so a
      // later continue/resume of the same id is never blocked by a stale lock.
      try {
        rmSync(turnLockPath(safeId), { force: true });
      } catch {
        // best-effort; a leftover lock is reconciled on acquire if it persists.
      }
      // 会话文件已经没了，但它的 btw 线程可能还在（另一进程删的会话）。
      deleteBtwState(safeId);
      return false;
    }
    rmSync(path, { force: true });
    try {
      this.removeFromIndex(safeId);
    } catch {
      // best-effort metadata index; a rebuild reconciles it on the next list.
    }
    // Drop the turn-lock alongside the session so a removed id never leaves a
    // lock behind. The lease dir is not part of the session scan, so it leaks.
    try {
      rmSync(turnLockPath(safeId), { force: true });
    } catch {
      // best-effort; a leftover lock is reconciled on acquire if it persists.
    }
    // By The Way threads belong to the session too（$MICA_HOME/btw/<id>.json）；
    // 不清掉的话，删了会话以后它的问答还会留着，且没有任何入口能再打开它。
    deleteBtwState(safeId);
    return true;
  }
  /** Returns all summaries (sorted by updatedAt desc) without parsing session bodies. */
  private ensureIndex(): SessionSummary[] {
    const dirMtime = dirMtimeMs();
    if (this.cachedIndex && this.cachedIndexDirMtime === dirMtime) return this.cachedIndex;
    this.cachedIndex = this.buildIndexFromDiskOrRebuild();
    this.cachedIndexDirMtime = dirMtime;
    return this.cachedIndex;
  }

  /** Returns the on-disk index when it is complete and current, otherwise
   * rebuilds it from the session files so entries dropped by concurrent
   * writers (or missing legacy files) are reconciled. */
  private buildIndexFromDiskOrRebuild(): SessionSummary[] {
    const fromDisk = this.readIndexFromDisk();
    if (fromDisk && this.indexMatchesDisk(fromDisk)) {
      this.cachedRejects = fromDisk.rejects;
      return fromDisk.sessions;
    }
    const rebuilt = this.rebuildIndex();
    // Persist the rebuilt index even if we already had a cache: an incomplete
    // on-disk index (e.g. another process added sessions, or an earlier build
    // never persisted) would otherwise force every subsequent reader to rescan
    // and re-parse every session file.
    this.cachedIndex = rebuilt.sessions;
    this.cachedRejects = rebuilt.rejects;
    this.persistIndex(rebuilt);
    return rebuilt.sessions;
  }

  /** True when the index accounts for exactly the files currently on disk:
   * every summary and every reject has a file, the rejects are unchanged, and
   * no file is left unaccounted for. A mismatch means another process
   * registered/removed sessions, so a rebuild is the safe source. */
  private indexMatchesDisk(index: SessionIndex): boolean {
    try {
      const fileIds = listSessionIds();
      if (fileIds.size !== index.sessions.length + index.rejects.length) return false;
      if (!index.sessions.every((summary) => fileIds.has(summary.id))) return false;
      for (const reject of index.rejects) {
        if (!fileIds.has(reject.id)) return false;
        // 文件变过就重扫一次，让它有机会重新解析成功（例如被压缩/修复过）。
        const stat = statSync(sessionPath(reject.id));
        if (stat.size !== reject.size || stat.mtimeMs !== reject.mtimeMs) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private readIndexFromDisk(): SessionIndex | null {
    try {
      if (!existsSync(SESSION_INDEX_FILE)) return null;
      const data = JSON.parse(readFileSync(SESSION_INDEX_FILE, 'utf-8')) as unknown;
      if (!data || typeof data !== 'object') return null;
      // 版本对不上就重建：旧索引里的摘要缺新字段（例如 v2 没有 parentSessionId），
      // 留着会让侧栏一直按「没有父会话」渲染，直到那一条会话恰好被改写。
      if ((data as { version?: unknown }).version !== SESSION_INDEX_VERSION) return null;
      const sessions = (data as { sessions?: unknown }).sessions;
      if (!Array.isArray(sessions)) return null;
      const rejects = (data as { rejects?: unknown }).rejects;
      return {
        sessions: sessions.filter(isSessionSummary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        // v1 索引没有 rejects：返回空数组，于是第一次读会重建一次并升到 v2。
        rejects: Array.isArray(rejects) ? rejects.filter(isIndexReject) : [],
      };
    } catch {
      return null;
    }
  }

  private rebuildIndex(): SessionIndex {
    ensureSessionDir();
    const summaries: SessionSummary[] = [];
    const rejects: IndexReject[] = [];
    for (const file of readdirSync(SESSION_DIR)) {
      if (!file.endsWith('.json') || file === 'index.json' || file === 'session-index.json') continue;
      const path = resolve(SESSION_DIR, file);
      // 索引只需要摘要字段，它们全在文件头里；整份 JSON.parse 会把几十 MB
      // 的图片与工具历史一起读进来（实测 474 条会话 1.3s，正是 /resume 的卡顿）。
      // 大会话（必然有对话与用量）只读头，小文件才整份解析——垃圾占位的判定
      // 需要知道 conversationMessages / usageHistory 是否为空。
      const large = (safeStat(path)?.size ?? 0) > HEAD_ONLY_SUMMARY_BYTES;
      if (large) {
        const summary = readHeadSummary(path);
        if (summary) {
          summaries.push(summary);
          continue;
        }
      }
      const session = this.read(path);
      if (!session) {
        // 旧格式（没有 version/snapshot）：记进 rejects，让 id 集合能对上磁盘。
        const stat = safeStat(path);
        if (stat) rejects.push({ id: file.slice(0, -'.json'.length), size: stat.size, mtimeMs: stat.mtimeMs });
        continue;
      }
      if (isJunkEmptySession(session)) {
        // A session with no user/assistant conversation and no usage is a
        // leftover from an allowEmpty turn-start save. Drop it entirely unless
        // it is running (an active turn may still be writing to it). Running
        // junk is kept and indexed so the id-set still matches the files on
        // disk (which keeps indexMatchesDisk happy) but is hidden from /resume
        // by isJunkSummary.
        if (session.turnState !== 'running') {
          try {
            rmSync(path, { force: true });
          } catch {
            // best-effort; the file is simply skipped on the next scan.
          }
          continue;
        }
      }
      const summary = toSessionSummary(session);
      if (summary) summaries.push(summary);
    }
    return {
      sessions: summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      rejects,
    };
  }

  private persistIndex(index: SessionIndex = { sessions: this.cachedIndex ?? [], rejects: this.cachedRejects }): void {
    const content = JSON.stringify(
      { version: SESSION_INDEX_VERSION, sessions: index.sessions, rejects: index.rejects },
      null,
      2,
    );
    const tmpPath = `${SESSION_INDEX_FILE}.${process.pid}.tmp`;
    mkdirSync(MICA_HOME, { recursive: true });
    writeFileSync(tmpPath, `${content}\n`, 'utf-8');
    renameSync(tmpPath, SESSION_INDEX_FILE);
  }

  private updateIndexForSave(session: PersistedSession): void {
    const summary = toSessionSummary(session);
    this.mutateIndex((index) => {
      const existing = index.findIndex((entry) => entry.id === summary.id);
      if (existing >= 0) index[existing] = summary;
      else index.push(summary);
      index.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }

  private removeFromIndex(id: string): void {
    this.mutateIndex((index) => {
      const existing = index.findIndex((entry) => entry.id === id);
      if (existing >= 0) index.splice(existing, 1);
    });
  }

  private mutateIndex(mutate: (index: SessionSummary[]) => void): void {
    // Merge against the latest on-disk index rather than a possibly-stale
    // in-memory cache, so a process that saves after another process already
    // persisted its own session never drops that other process's entries.
    //
    // Never re-parse every session file on the save path: a turn persists the
    // session several times, so the merge base must be the cheap on-disk index
    // read instead of a full scan+parse. Id-set drift (addition/removal by
    // another process or an incomplete index) is repaired by the read path
    // (buildIndexFromDiskOrRebuild), which rescans and persists a complete
    // index once; the live turn stays responsive.
    const fromDisk = this.readIndexFromDisk();
    let next: SessionIndex;
    if (fromDisk) {
      next = fromDisk;
    } else if (this.cachedIndex) {
      const cached = { sessions: this.cachedIndex, rejects: this.cachedRejects };
      next = this.indexMatchesDisk(cached) ? cached : this.rebuildIndex();
    } else {
      next = this.rebuildIndex();
    }
    mutate(next.sessions);
    // 刚保存的会话不可能是「读不出摘要」的旧文件，顺手清掉同名 reject。
    const savedIds = new Set(next.sessions.map((entry) => entry.id));
    next.rejects = next.rejects.filter((reject) => !savedIds.has(reject.id));
    this.cachedIndex = next.sessions;
    this.cachedRejects = next.rejects;
    this.cachedIndexDirMtime = dirMtimeMs();
    this.persistIndex(next);
  }

  private read(path: string): PersistedSession | null {
    try {
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      return parsePersistedSession(data);
    } catch {
      return null;
    }
  }

  private readForUsage(path: string): PersistedSession | null {
    try {
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      return parsePersistedSession(data) ?? (Array.isArray(data) ? parseLegacySessionForUsage(path, data) : null);
    } catch {
      return null;
    }
  }
}

export const micaSessionStore = {
  dir: SESSION_DIR,
  createStore: createSessionStore,
  createId: createSessionId,
  acquireTurnLease: acquireSessionTurnLease,
  SessionStore,
};

/** Prevents local and remote turns from replacing the same session snapshot. */
export function acquireSessionTurnLease(sessionId: string): SessionTurnLease | null {
  const safeId = sanitizeSessionId(sessionId);
  if (!safeId || safeId !== sessionId) return null;
  ensureSessionDir();
  const lockDir = resolve(SESSION_DIR, '.turn-locks');
  mkdirSync(lockDir, { recursive: true });
  const lockPath = turnLockPath(safeId);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), 'utf8');
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        sessionId: safeId,
        release() {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: unknown };
            if (owner.token === token) rmSync(lockPath, { force: true });
          } catch {
            // Never remove a lock unless its token proves that we own it.
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error) || attempt > 0 || !removeStaleTurnLease(lockPath)) return null;
    }
  }
  return null;
}

export function createSessionId(date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

/**
 * 超过这个体量的会话一定有对话或用量，索引不再整份解析它。
 * 垃圾占位（allowEmpty 起始保存的残留）永远是几百字节到几 KB，落在这条线以下。
 */
const HEAD_ONLY_SUMMARY_BYTES = 64 * 1024;

const HEAD_SUMMARY_BYTES = 8192;

/**
 * 只读文件头拼出索引摘要。会话文件把顶层字段与 `snapshot` 的前几个键写在最前面，
 * 所以摘要、模型与角色都在前 8 KB 里，不必为 474 条会话各 parse 一份几十 MB 的正文。
 * 任何一个必需字段没读到就返回 null，调用方回落到整份解析。
 */
function readHeadSummary(path: string): SessionSummary | null {
  const stat = safeStat(path);
  if (!stat) return null;
  const head = readSessionFileHead(path, HEAD_SUMMARY_BYTES);
  if (!head) return null;
  const id = readHeadString(head, 'id');
  const updatedAt = readHeadString(head, 'updatedAt');
  const cwd = readHeadString(head, 'cwd');
  const providerId = readHeadString(head, 'providerId');
  const model = readHeadString(head, 'model');
  if (!id || !updatedAt || !cwd || !providerId || !model) return null;
  const turnState = readHeadString(head, 'turnState');
  const role = readHeadString(head, 'role');
  const effort = readHeadString(head, 'effort');
  const parentSessionId = readHeadString(head, 'parentSessionId');
  const createdAt = readHeadString(head, 'createdAt');
  const title = readHeadString(head, 'title');
  return {
    id,
    title: displayTitle(title ?? id),
    ...(createdAt ? { createdAt } : {}),
    updatedAt,
    cwd,
    ...(parentSessionId ? { parentSessionId } : {}),
    providerId,
    model,
    uncompleted: turnState !== 'completed',
    ...(isTurnState(turnState) ? { turnState } : {}),
    ...(effort ? { effort } : {}),
    ...(role ? { role } : {}),
    // 大会话按定义就有内容：垃圾占位不可能长到这么大。
    hasConversation: true,
    hasUsage: true,
  };
}

function isTurnState(value: string | undefined): value is PersistedSessionTurnState {
  return value === 'running' || value === 'completed' || value === 'aborted' || value === 'error';
}

function toSessionSummary(session: PersistedSession): SessionSummary {
  return {
    id: session.id,
    title: displayTitle(session.title),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    providerId: session.snapshot.providerId,
    model: session.snapshot.model,
    uncompleted: session.turnState !== 'completed',
    turnState: session.turnState,
    effort: session.snapshot.effort,
    role: session.snapshot.role,
    hasConversation: hasConversationData(session.snapshot),
    hasUsage: (session.snapshot.usageHistory?.length ?? 0) > 0,
  };
}

/**
 * 老会话的标题可能是从带图片的输入原样截出来的（`[Image](/Users/…/a.png) 帮我看下`），
 * 本地路径对列表毫无意义。读取时剥掉占位符就够了，不必改写用户文件 —— 下次保存会写成干净标题。
 */
function displayTitle(title: string): string {
  const stripped = stripMediaPlaceholders(title).replace(/\s+/g, ' ').trim();
  return stripped || title;
}

function dirMtimeMs(): number {
  try {
    return statSync(SESSION_DIR).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Hides (and, on rebuild, deletes) a leftover from an allowEmpty turn-start
 * save that never produced any content.
 *
 * Only the placeholder title is not enough to call a session junk: a session
 * whose stored title is still `Untitled session` may well carry a real
 * conversation (the title is re-derived on later saves, and `deriveTitle`
 * cannot always find a user prompt). Junk therefore requires *no* conversation
 * data and no usage, matching {@link isJunkEmptySession}.
 *
 * A `running` session is never junk: it marks a turn that was in flight when
 * the process went away, which is exactly the crash residue the product keeps
 * on disk so the session can be found in /resume and resumed (rendered as
 * `（uncompleted）` / the red "did not finish" indicator).
 */
function isJunkSummary(summary: SessionSummary): boolean {
  if (!isJunkPlaceholder(summary)) return false;
  return summary.turnState !== 'running';
}

/** A persisted session is junk when it holds no user/assistant conversation,
 * no model usage, and only the default title: a leftover from an allowEmpty
 * turn-start save that never produced content before the process exited. */
function isJunkEmptySession(session: PersistedSession): boolean {
  return isJunkPlaceholder({
    title: session.title,
    hasConversation: hasConversationData(session.snapshot),
    hasUsage: (session.snapshot.usageHistory?.length ?? 0) > 0,
  });
}

/** Shared rule behind hiding a summary and deleting a rebuilt session file:
 * the placeholder title plus no content of any kind. The `running` exception
 * is applied by the callers (a live/interrupted turn must stay on disk). */
function isJunkPlaceholder(summary: Pick<SessionSummary, 'title' | 'hasConversation' | 'hasUsage'>): boolean {
  if (summary.title !== UNTITLED_SESSION_TITLE) return false;
  if (summary.hasConversation) return false;
  return !summary.hasUsage;
}

function hasConversationData(snapshot: PersistedRuntimeSnapshot): boolean {
  const hasConversationMessage = snapshot.conversationMessages?.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const role = (message as { role?: unknown }).role;
    return role === 'user' || role === 'assistant';
  });
  if (hasConversationMessage) return true;
  return snapshot.messages?.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const role = (message as { role?: unknown }).role;
    return role === 'user' || role === 'assistant';
  });
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.id === 'string' &&
    typeof session.title === 'string' &&
    typeof session.cwd === 'string' &&
    typeof session.updatedAt === 'string' &&
    typeof session.providerId === 'string' &&
    typeof session.model === 'string' &&
    typeof session.uncompleted === 'boolean' &&
    // 侧栏按它做嵌套：非字符串的脏值会让渲染层把每个 id 都当父 id。
    (session.parentSessionId === undefined || typeof session.parentSessionId === 'string') &&
    // Entries written before the junk rule started honouring conversation
    // content lack these fields. Rejecting them forces one rebuild (the index
    // is only a cache), which also guarantees the junk rule never reads an
    // `undefined` flag as "no content" and hides a real session.
    typeof session.hasConversation === 'boolean' &&
    typeof session.hasUsage === 'boolean'
  );
}

function createSessionStore(): SessionStore {
  return new SessionStore();
}

function ensureSessionDir() {
  mkdirSync(SESSION_DIR, { recursive: true });
}

function isIndexReject(value: unknown): value is IndexReject {
  if (!value || typeof value !== 'object') return false;
  const reject = value as Record<string, unknown>;
  return typeof reject.id === 'string' && typeof reject.size === 'number' && typeof reject.mtimeMs === 'number';
}

/** sessions/ 里当前所有会话文件的 id（不含索引自身的两个保留名）。 */
function listSessionIds(): Set<string> {
  return new Set(
    readdirSync(SESSION_DIR)
      .filter((file) => file.endsWith('.json') && file !== 'index.json' && file !== 'session-index.json')
      .map((file) => file.slice(0, -'.json'.length)),
  );
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function sessionPath(id: string): string {
  return resolve(SESSION_DIR, `${id}.json`);
}

function turnLockPath(id: string): string {
  return resolve(SESSION_DIR, '.turn-locks', `${id}.lock`);
}

function sanitizeSessionId(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed || basename(trimmed) !== trimmed) return null;
  const safe = trimmed.replace(/\.json$/, '');
  return safe && /^[a-zA-Z0-9_.-]+$/.test(safe) ? safe : null;
}

function removeStaleTurnLease(lockPath: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < MALFORMED_LEASE_STALE_MS) return false;
      rmSync(lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

export function parsePersistedSession(value: unknown): PersistedSession | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Partial<PersistedSession>;
  if (session.version !== 1) return null;
  if (!isNonEmptyString(session.id) || sanitizeSessionId(session.id) !== session.id) return null;
  if (!isNonEmptyString(session.title)) return null;
  if (!isNonEmptyString(session.createdAt) || !isNonEmptyString(session.updatedAt) || !isNonEmptyString(session.cwd)) {
    return null;
  }
  if (!session.snapshot || typeof session.snapshot !== 'object') return null;
  if (!isNonEmptyString(session.snapshot.providerId) || !isNonEmptyString(session.snapshot.model)) return null;
  if (!Array.isArray(session.snapshot.messages)) return null;
  if (!Array.isArray(session.snapshot.conversationMessages)) return null;
  if (!Array.isArray(session.snapshot.usageHistory)) return null;
  if (session.snapshot.subagentUsageHistory !== undefined && !Array.isArray(session.snapshot.subagentUsageHistory)) {
    return null;
  }
  // 耗时记录是纯展示数据：坏掉的条目丢掉就好，不值得为它拒掉整份会话。
  if (session.snapshot.turnTimings !== undefined) {
    session.snapshot.turnTimings = normalizeTurnTimings(session.snapshot.turnTimings);
  }
  // 插件状态缺失允许（没有任何插件写过），存在就必须是普通对象——它是「插件 id →
  // JSON」的映射，别的形状进不了读写路径，只会让每次保存都原样写回脏数据。
  if (session.snapshot.pluginState !== undefined && !isPlainRecord(session.snapshot.pluginState)) return null;
  // 覆盖只可能是「插件 id → 字符串映射」；别的形状读进来会让界面按字段渲染出一堆
  // 不存在的项，所以在解析阶段就拒绝，而不是留到运行期再清洗。
  if (session.snapshot.pluginSessionSettings !== undefined) {
    const record = session.snapshot.pluginSessionSettings;
    if (!isPlainRecord(record)) return null;
    for (const value of Object.values(record)) {
      if (!isPlainRecord(value)) return null;
      if (!Object.values(value).every((item) => typeof item === 'string')) return null;
    }
  }
  const turnState = isPersistedSessionTurnState(session.turnState) ? session.turnState : 'completed';
  // 「在等你选」只属于还没跑完的那一轮：轮次结束后残留的标记会让侧栏一直亮着一个
  // 不存在的问题。形状不对按缺省处理（同 parentSessionId），不为一个提示字段拒绝整条会话。
  const awaitingInput = normalizeAwaitingInput(session.awaitingInput, turnState);
  let protocol = session.snapshot.protocol;
  if (!isProviderProtocol(protocol)) {
    const provider: ProviderProtocol | undefined = session.snapshot.usageHistory
      ?.map((record) => record?.provider)
      .find(isProviderProtocol);
    protocol = provider ?? 'openai_chat_completions';
  }
  // 档位名随模型而变（`max`、`minimal`、`on` …），只做语法校验；是否被当前模型支持由
  // `normalizeModelEffort` 在恢复会话时收敛。
  if (!isEffortLevelName(session.snapshot.effort)) return null;
  const role = isNonEmptyString(session.snapshot.role) ? session.snapshot.role : 'default';
  const systemPrompt = normalizeSystemPrompt(session.snapshot.systemPrompt);
  return {
    ...session,
    // 父会话只是展示线索：坏值（不存在的形状、自指）丢掉就行，不为了一个
    // 可选的展示字段拒绝整条会话。
    parentSessionId: normalizeParentSessionId(session.parentSessionId, session.id),
    turnState,
    ...(awaitingInput ? { awaitingInput } : { awaitingInput: undefined }),
    snapshot: {
      ...session.snapshot,
      protocol,
      role,
      // 宽松解析：只认 true，其他值当作「未定制」，不因此拒绝整条会话。
      capabilitiesCustomized: session.snapshot.capabilitiesCustomized === true ? true : undefined,
      displayUsage: normalizeDisplayUsage(session.snapshot.displayUsage),
      systemPrompt,
      interruptedThinking: normalizeInterruptedThinking(
        session.snapshot.interruptedThinking,
        session.snapshot.providerId,
        protocol,
        session.snapshot.model,
      ),
      activeThinking: normalizeInterruptedThinking(
        session.snapshot.activeThinking,
        session.snapshot.providerId,
        protocol,
        session.snapshot.model,
      ),
      activeTurn:
        turnState === 'running' && protocol === 'openai_responses'
          ? normalizeActiveTurn(session.snapshot.activeTurn)
          : undefined,
    },
  } as PersistedSession;
}

function normalizeActiveTurn(value: unknown): PersistedRuntimeSnapshot['activeTurn'] {
  if (!isPlainRecord(value) || typeof value.committed !== 'boolean') return undefined;
  if (typeof value.input === 'string') return { input: value.input, committed: value.committed };
  if (!Array.isArray(value.input)) return undefined;
  const input: Exclude<AgentQueryContent, string> = [];
  for (const part of value.input) {
    if (!isPlainRecord(part)) return undefined;
    if (part.type === 'text' && typeof part.text === 'string') {
      input.push({ type: 'text', text: part.text });
    } else if (
      part.type === 'image' &&
      isPlainRecord(part.source) &&
      part.source.type === 'base64' &&
      typeof part.source.data === 'string' &&
      (part.source.media_type === 'image/jpeg' ||
        part.source.media_type === 'image/png' ||
        part.source.media_type === 'image/gif' ||
        part.source.media_type === 'image/webp')
    ) {
      input.push({
        type: 'image',
        source: { type: 'base64', media_type: part.source.media_type, data: part.source.data },
      });
    } else {
      return undefined;
    }
  }
  return { input, committed: value.committed };
}

function normalizeInterruptedThinking(
  value: unknown,
  providerId: string,
  protocol: ProviderProtocol,
  model: string,
): PersistedRuntimeSnapshot['interruptedThinking'] {
  if (!value || typeof value !== 'object') return undefined;
  const thinking = value as Partial<NonNullable<PersistedRuntimeSnapshot['interruptedThinking']>>;
  if (
    protocol !== 'openai_responses' ||
    thinking.protocol !== protocol ||
    thinking.providerId !== providerId ||
    thinking.model !== model ||
    typeof thinking.apiBase !== 'string' ||
    typeof thinking.text !== 'string' ||
    !thinking.text
  )
    return undefined;
  return { providerId, protocol, model, apiBase: thinking.apiBase, text: thinking.text };
}

/** 父会话 id 必须是能落到磁盘的会话 id，且不能是自己（自指会让侧栏嵌套成环）。 */
function normalizeParentSessionId(value: unknown, selfId: string): string | undefined {
  if (!isNonEmptyString(value)) return undefined;
  const id = value.trim();
  if (id === selfId) return undefined;
  return sanitizeSessionId(id) === id ? id : undefined;
}

/**
 * 「在等你选」最多一百来个字：它要显示在侧栏一行里，长句子只会被省略号吃掉。
 * 类型不对或那一轮已经结束就丢掉——它只是提示，不该让整条会话读不出来。
 */
const MAX_AWAITING_INPUT = 120;

function normalizeAwaitingInput(
  value: unknown,
  turnState: PersistedSessionTurnState,
): string | undefined {
  if (turnState === 'completed') return undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > MAX_AWAITING_INPUT ? text.slice(0, MAX_AWAITING_INPUT) : text;
}

function normalizeDisplayUsage(value: unknown): PersistedSnapshotDisplayUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<PersistedSnapshotDisplayUsage>;
  const totalTokens = Number(record.totalTokens);
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return undefined;
  if (!isNonEmptyString(record.compactedAt)) return undefined;
  return { totalTokens, compactedAt: record.compactedAt };
}

/** 提示词只用于展示：坏值（不是字符串 / 空串）丢掉就行，不为了一个可选镜像拒绝整条会话。 */
function normalizeSystemPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 普通对象（不是数组、不是 Date/Map 这类实例）。插件状态只接受这种形状。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseLegacySessionForUsage(path: string, messages: unknown[]): PersistedSession | null {
  const usageHistory: AgentUsageRecord[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const raw = (message as { usage?: unknown }).usage;
    if (!raw || typeof raw !== 'object') continue;
    const usage = raw as Record<string, unknown>;
    const uncached = finiteNumber(usage.input_tokens);
    const cacheRead = finiteNumber(usage.cache_read_input_tokens);
    const cacheWrite = finiteNumber(usage.cache_creation_input_tokens);
    const output = finiteNumber(usage.output_tokens);
    if (uncached + cacheRead + cacheWrite + output === 0) continue;
    const input = uncached + cacheRead + cacheWrite;
    usageHistory.push({
      provider: 'openai_chat_completions',
      turnId: usageHistory.length + 1,
      requestIndex: 0,
      messageCount: messages.length,
      inputTokens: input,
      cachedInputTokens: cacheRead,
      outputTokens: output,
      totalTokens: input + output,
      paidTokenRate: input > 0 ? (uncached + cacheWrite) / input : 1,
    });
  }
  if (usageHistory.length === 0) return null;
  const id = basename(path, '.json');
  const updatedAt = statSync(path).mtime.toISOString();
  return {
    version: 1,
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    cwd: '',
    turnState: 'completed',
    snapshot: {
      providerId: 'legacy',
      protocol: 'openai_chat_completions',
      model: 'legacy',
      effort: 'none',
      role: 'default',
      messages: [],
      conversationMessages: [],
      usageHistory,
      lastUsage: usageHistory.at(-1),
    },
  };
}

function isPersistedSessionTurnState(value: unknown): value is PersistedSessionTurnState {
  return value === 'running' || value === 'completed' || value === 'aborted' || value === 'error';
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
