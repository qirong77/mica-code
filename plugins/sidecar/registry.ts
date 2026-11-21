import type { PluginContext } from '@packages/mica-plugin/index.js';
import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { SidecarEventLog, summarizeTurn, turnStatusLabel, type SidecarEvent, type SidecarEventKind } from './events.js';
import { readSessionHistory } from './history.js';
import {
  resolveSessionCwd,
  SidecarProcess,
  type SidecarProcessOptions,
} from './sidecarProcess.js';
import type { SidecarTranscript, SidecarTurn } from './transcript.js';
import { clip } from './views.js';

/**
 * 进程已经退出的条目最多留几条。
 *
 * 死条目不能立刻删：最后一轮的输出与退出原因只在它手里，而用户恰恰是「怎么没动静
 * 了」的时候来查。留最近的几条够用，全留就是一个越攒越大的内存垃圾堆。
 */
export const MAX_DEAD_ENTRIES = 4;

/** 等条件的后台登记多久之后作废：没人会等一个两小时前的结论。 */
const WATCHER_TTL_MS = 30 * 60_000;

/** 停滞判定的缺省值：5 分钟没有任何新输出，而这一轮还在跑。 */
export const DEFAULT_STALL_MS = 5 * 60_000;
/**
 * 空闲自动回收的缺省值：0 = 不回收。
 *
 * 默认不回收的理由是「子会话要像一个正常会话一样在」：自动收掉进程会让它突然从
 * 面板里消失，而用户往往隔一阵才回来接着问。要省内存就在插件设置里填分钟数，
 * 收掉的只是进程（会话历史仍在，`sidecar_attach` 能接回来）。
 */
export const DEFAULT_RECYCLE_MS = 0;

export type SidecarEntry = {
  /** 会话 id（`thread/start` 返回）。第一轮结束前会话文件还不存在。 */
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  process: SidecarProcess;
  /** 上一次整份渲染时的 `transcript.revision`；用来认出「什么都没发生」的重复查询。 */
  seenRevision?: number;
  /** 已经上报过事件的轮次数：事件是「发生一次记一条」，不能每次变化都重记。 */
  seenFinishedTurns: number;
  /** 停滞提示是针对哪一轮发的：同一轮只提示一次，有新输出就重新计。 */
  stallTurnId?: string;
  /** 是否已上报进程退出。 */
  exitReported?: boolean;
  /** 最近一次被工具读取的时刻：空闲回收只在「结果已经有人读过」之后才动手。 */
  lastReadAt?: number;
  /** 接管来的会话（历史来自会话文件，而不是通知流）。 */
  attached?: boolean;
};

export type SpawnResult = { ok: true; entry: SidecarEntry } | { ok: false; error: string };

export type SidecarRegistryOptions = {
  /** 后台事件（轮次结束、退出、停滞…）的去处：注入 prompt + 落一条 notice。 */
  onEvent?: (event: SidecarEvent) => void;
  /** 停滞判定阈值（毫秒）。 */
  stallMs?: number;
  /** 空闲回收阈值（毫秒），0 表示不回收。 */
  recycleMs?: number;
  /**
   * 运行期重新读取的阈值（插件设置改完立刻生效）。
   *
   * 装配时读一次会让「把空闲回收从 15 分钟改成 0」必须重启宿主，而这几项恰好是用户
   * 调完想马上看到效果的东西。
   */
  limits?: () => Partial<Pick<SidecarRegistryOptions, 'stallMs' | 'recycleMs'>>;
  now?: () => number;
};

/** 后台等待的登记：`sidecar_wait` 超时之后仍然盯着，条件成立时变成一条事件。 */
type Watcher = {
  entryId: string;
  until: 'idle' | 'text' | 'turn';
  pattern: RegExp | null;
  baseline: WaitBaseline;
  expiresAt: number;
};

/**
 * 子会话用哪个角色。
 *
 * 显式给了就用给的；没给就**继承父会话当前的角色**，而不是回到配置里的 `default`。
 * 子会话是「同一个 agent 换个上下文干活」——默认换一套行为规则，读起来不像同一个
 * agent 在做事。父会话也没有角色（`undefined`）时返回 undefined，让宿主用自己的默认值。
 */
export function resolveSidecarRole(inputRole: string | undefined, parentRole: string | undefined): string | undefined {
  return inputRole?.trim() || parentRole?.trim() || undefined;
}

/**
 * 子会话的登记表。
 *
 * 只活在父会话的 app-server 进程里：父会话结束，子会话进程一起收掉（见 index.ts 的
 * onDispose）。它们不是「常驻服务」——用户关掉这条会话，就不该还有进程在后台烧 token。
 */
export class SidecarRegistry {
  private readonly entries = new Map<string, SidecarEntry>();
  /** 未读的后台事件：prompt 段落每轮取走一次（见 index.ts）。 */
  private readonly eventLog = new SidecarEventLog();
  /** 父会话登记的「后台等」：`sidecar_wait` 超时后继续盯着，条件成立时变成一条事件。 */
  private readonly watchers = new Map<string, Watcher>();
  private readonly startup = new AbortController();
  private readonly pendingStarts = new Set<Promise<SidecarProcess>>();
  /** 已从当前会话摘掉、但还没真正退出的进程，卸载时仍须等它们。 */
  private readonly retiring = new Set<Promise<void>>();
  /** 登记表绑定的父会话：会话在同一个 app-server 里换过（resume / 新对话）就不再是它。 */
  private boundParentId: string | null;
  /** 已被回收：还在握手的启动要自己收尾，回收之后也不许再派生。 */
  private disposed = false;
  private readonly now: () => number;

  constructor(
    private readonly ctx: PluginContext,
    private readonly parentSessionId: string | null,
    private readonly defaultCwd: string,
    /**
     * 父会话当前的角色：子会话不指定 role 时沿用它，而不是回到配置默认值。
     * 用函数而不是值——会话里切过角色之后再派，跟的要是切完的那个。
     */
    private readonly currentRole: () => string | undefined,
    private readonly options: SidecarRegistryOptions = {},
  ) {
    this.boundParentId = parentSessionId;
    this.now = options.now ?? (() => Date.now());
  }

  list(): SidecarEntry[] {
    this.syncParent();
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): SidecarEntry | null {
    this.syncParent();
    const key = String(id ?? '').trim();
    // 空前缀会让下面的 startsWith 命中所有条目：模型漏传 session_id 时不该静默
    // 命中「碰巧排第一」的那个会话。
    if (!key) return null;
    const exact = this.entries.get(key);
    if (exact) return exact;
    // 完整 id 有 36 个字符，模型抄写容易错；唯一前缀等价于它。
    const matches = this.list().filter((entry) => entry.id.startsWith(key));
    return matches.length === 1 ? matches[0]! : null;
  }

  /** 父会话的当前状态：会话换过就跟着换，不能一直用 setup 时抓到的那份。 */
  private currentSession(): { id: string | null; cwd: string } {
    const live = this.ctx.session?.describe();
    return { id: live?.id ?? this.parentSessionId, cwd: live?.cwd || this.defaultCwd };
  }

  /**
   * 父会话变了就把上一批子会话收掉。
   *
   * 它们挂在一条已经不存在的会话名下：用户看不到、工具也找不到，却还在跑、还在烧
   * token——那正是「没人收的子会话」这件事最隐蔽的一种形态。
   */
  private syncParent(): void {
    const current = this.currentSession().id;
    if (current === this.boundParentId) return;
    this.boundParentId = current;
    const stale = [...this.entries.values()];
    this.entries.clear();
    this.watchers.clear();
    this.eventLog.clear();
    for (const entry of stale) void this.trackClose(entry.process, 0);
  }

  /** 未读事件数：面板与状态行用它说「有几条新动态」。 */
  get pendingEventCount(): number {
    return this.eventLog.size;
  }

  /**
   * 取走未读事件并渲染成 prompt 段落。
   *
   * 读一次就清：同一件事在每一轮里重复进 prompt，既撑上下文、又让这一段之后的
   * prompt cache 每轮都失效。空串表示这一轮没有任何新动态——整段消失，前缀不变。
   */
  takeEventsForPrompt(): SidecarEvent[] {
    return this.eventLog.take();
  }

  /** 工具刚读过某个子会话：空闲回收据此判断「结果已经有人看过」。 */
  markRead(id: string): void {
    const entry = this.get(id);
    if (entry) entry.lastReadAt = this.now();
  }

  private emit(kind: SidecarEventKind, entry: SidecarEntry, summary: string, detail?: string): SidecarEvent {
    const event = this.eventLog.add({
      sessionId: entry.id,
      title: entry.title,
      kind,
      summary,
      ...(detail ? { detail } : {}),
    });
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      this.ctx.logger.warn('sidecar:event-handler-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return event;
  }

  /**
   * 订阅一个子进程的可见变化，把「它自己发生的事」翻译成事件。
   *
   * 为什么不做定时轮询：事件要在**发生的那一刻**记下来（父会话这一刻可能正忙），
   * 而 `SidecarProcess` 每次有变化都会通知等待者，这里只是多挂一个观察者。
   */
  private watchEntry(entry: SidecarEntry): void {
    entry.seenFinishedTurns = entry.process.transcript?.finishedTurnCount ?? 0;
    // 测试里的假进程没有订阅口：事件是附加能力，缺了也不能影响派生本身。
    entry.process.subscribe?.(() => this.observe(entry));
  }

  private observe(entry: SidecarEntry): void {
    const transcript = entry.process.transcript;
    const finished = transcript.finishedTurnCount;
    if (finished > entry.seenFinishedTurns) {
      entry.seenFinishedTurns = finished;
      // `turns` 里最后一条就是刚结束的那一轮（进程退出时也会把在跑的那轮收尾）。
      const turn = transcript.turns.at(-1);
      if (turn) {
        entry.stallTurnId = undefined;
        const seconds = turn.finishedAt ? Math.max(0, Math.round((turn.finishedAt - turn.startedAt) / 1000)) : 0;
        this.emit('turn', entry, `${turnStatusLabel(turn.status)} · ${seconds}s · ${summarizeTurn(turn)}`);
        this.satisfyWatchers(entry);
      }
    }
    if (entry.process.closed && !entry.exitReported) {
      entry.exitReported = true;
      this.emit('exit', entry, '子会话进程已退出', clip(entry.process.describeFailure().replace(/\s+/g, ' '), 200));
      this.watchers.delete(entry.id);
    }
  }

  /**
   * 登记一次后台等待。
   *
   * `sidecar_wait` 阻塞到超时之后用它接棒：父会话不必为了「它还跑着」再查一次——
   * 条件成立时那条事件会跟着下一轮 prompt 一起到达。
   */
  registerWatcher(entry: SidecarEntry, until: 'idle' | 'text' | 'turn', pattern: RegExp | null): void {
    this.watchers.set(entry.id, {
      entryId: entry.id,
      until,
      pattern,
      baseline: waitBaseline(entry.process.transcript),
      expiresAt: this.now() + WATCHER_TTL_MS,
    });
  }

  hasWatcher(id: string): boolean {
    return this.watchers.has(id);
  }

  private satisfyWatchers(entry: SidecarEntry): void {
    const watcher = this.watchers.get(entry.id);
    if (!watcher) return;
    const verdict = waitSatisfied(entry.process.transcript, watcher.until, watcher.pattern, watcher.baseline);
    if (!verdict.done) return;
    this.watchers.delete(entry.id);
    this.emit('watch', entry, verdict.detail ?? '你等的条件已经成立');
  }

  /**
   * 看门狗的一轮：停滞、空闲回收。
   *
   * 这三件事都要一个钟，而进程只在「有变化」时通知我们——一个彻底卡死的子会话
   * 永远不会再通知第二声。
   */
  tick(): { stalled: string[]; recycled: string[] } {
    const now = this.now();
    const stalled: string[] = [];
    const recycled: string[] = [];
    for (const [id, watcher] of [...this.watchers]) {
      if (watcher.expiresAt <= now) this.watchers.delete(id);
    }
    this.sweep();
    for (const entry of this.list()) {
      const transcript = entry.process.transcript;
      const id = entry.id;
      if (entry.process.closed) continue;
      const idleMs = now - transcript.lastActivityAt;
      if (transcript.busy) {
        const turnId = transcript.activeTurnId ?? '';
        if (idleMs >= this.limits().stallMs && entry.stallTurnId !== turnId) {
          entry.stallTurnId = turnId;
          const tool = transcript.runningTool;
          stalled.push(id);
          this.emit(
            'stalled',
            entry,
            `${Math.round(idleMs / 60_000)} 分钟没有新输出` +
              (tool ? `，当前工具「${clip(tool.title, 80)}」还在跑` : ''),
            '可能卡在一条命令或等一个外部服务，可以 sidecar_status 看一眼，必要时 sidecar_abort',
          );
        }
        continue;
      }
      entry.stallTurnId = undefined;
      const recycleMs = this.limits().recycleMs;
      if (recycleMs <= 0 || idleMs < recycleMs) continue;
      // 只回收「结果已经有人读过」的：刚跑完还没人看就收掉，等于把结论删了。
      const read = entry.lastReadAt !== undefined && entry.lastReadAt >= transcript.lastActivityAt;
      if (!read) continue;
      recycled.push(id);
      void this.close(id).catch(() => undefined);
      this.eventLog.add({
        sessionId: entry.id,
        title: entry.title,
        kind: 'recycled',
        summary: `空闲 ${Math.round(idleMs / 60_000)} 分钟，进程已收掉（会话历史仍在，需要时 sidecar_attach 接回来）`,
      });
    }
    return { stalled, recycled };
  }

  async spawn(input: {
    prompt: string;
    cwd?: string;
    title?: string;
    role?: string;
    model?: string;
    effort?: string;
    signal?: AbortSignal;
  }): Promise<SpawnResult> {
    // 回收之后还派：这个进程马上要退出，派出来的孩子没人管。
    if (this.disposed) return { ok: false, error: '会话已经关闭，不再派生新的子会话。' };
    if (input.signal?.aborted) return { ok: false, error: '派生子会话已取消。' };
    this.sweep();
    // 工作目录的规范化（绝对路径、~ 展开、存在性）统一在 SidecarProcess.start 里做：
    // 那里才知道这个值会同时被当作子进程 cwd 和 --dir。
    const parent = this.currentSession();
    const cwd = resolveSessionCwd(input.cwd, parent.cwd);
    const prompt = input.prompt.trim();
    if (!prompt) return { ok: false, error: 'prompt 不能为空：子会话需要一句话才知道自己该做什么。' };
    const role = resolveSidecarRole(input.role, this.currentRole());

    const options: SidecarProcessOptions = {
      cwd,
      // 不传 role 时沿用父会话的角色：子会话是「同一个 agent 换个上下文干活」，
      // 默认落到配置里的 default 会让它的行为规则跟父会话不一致。
      ...(role ? { role } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(parent.id ? { parentSessionId: parent.id } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    };

    let process_: SidecarProcess;
    try {
      process_ = await this.startProcess(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.error('sidecar:spawn-failed', { error: message });
      return { ok: false, error: `子会话启动失败：${message}` };
    }

    // 握手期间宿主被回收了（closeAll）：这个孩子没人要了，收掉、也别投第一句话。
    if (this.disposed) {
      await process_.close(0);
      return { ok: false, error: '会话在启动子会话的过程中关闭了，子会话没有启动。' };
    }
    if (input.signal?.aborted) {
      await process_.close(0);
      return { ok: false, error: '派生子会话已取消。' };
    }
    if (this.currentSession().id !== parent.id) {
      await process_.close(0);
      return { ok: false, error: '启动期间父会话已切换，子会话已取消。' };
    }

    const id = process_.sessionId;
    if (!id) {
      await process_.close();
      return { ok: false, error: '子会话启动失败：app-server 没有返回会话 id。' };
    }
    const entry: SidecarEntry = {
      id,
      title: input.title?.trim() || firstLine(prompt),
      // 用进程手里的规范路径（不是入参）：报告给用户的目录必须是子会话真正工作的那个。
      cwd: process_.cwd,
      createdAt: Date.now(),
      process: process_,
      seenFinishedTurns: 0,
    };
    this.entries.set(id, entry);
    this.watchEntry(entry);
    this.ctx.logger.info('sidecar:spawned', { sessionId: id, cwd: entry.cwd });

    const cancelSend = () => {
      void process_.close(0);
    };
    input.signal?.addEventListener('abort', cancelSend, { once: true });
    try {
      await process_.send(prompt);
      input.signal?.throwIfAborted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 第一句没投出去，这个子会话就是个空壳：收掉，别在侧栏留一条空会话。
      this.entries.delete(id);
      await process_.close(input.signal?.aborted ? 0 : undefined);
      if (input.signal?.aborted) return { ok: false, error: '派生子会话已取消。' };
      return { ok: false, error: `子会话已启动，但第一句话没投出去：${message}` };
    } finally {
      input.signal?.removeEventListener('abort', cancelSend);
    }
    return { ok: true, entry };
  }

  async close(id: string): Promise<boolean> {
    const entry = this.get(id);
    if (!entry) return false;
    this.entries.delete(entry.id);
    this.watchers.delete(entry.id);
    // 主动收掉的会话不该再报一条「进程退出了」：那是给意外退出准备的。
    entry.exitReported = true;
    // 进程都没了，再把这个会话的事件留着只会让人去找一个已经不在的条目。
    this.eventLog.dropSession(entry.id);
    await this.trackClose(entry.process);
    this.ctx.logger.info('sidecar:closed', { sessionId: entry.id });
    return true;
  }

  /** 落盘会话目录：接管已有会话时要读它（历史不在通知流里）。 */
  private sessionsDir(): string {
    return join(this.ctx.paths?.home ?? resolveMicaHome(), 'sessions');
  }

  /** 当前生效的两项阈值：静态配置打底，插件设置运行期覆盖。 */
  private limits(): { stallMs: number; recycleMs: number } {
    const live = this.options.limits?.() ?? {};
    return {
      stallMs: live.stallMs ?? this.options.stallMs ?? DEFAULT_STALL_MS,
      recycleMs: live.recycleMs ?? this.options.recycleMs ?? DEFAULT_RECYCLE_MS,
    };
  }

  /**
   * 接管一条已经存在的会话（`sidecar_attach`）。
   *
   * 与 `spawn` 的区别只有两处：会话是**已有的**（历史从会话文件补，不新建一条空会话），
   * 以及不投第一句话——接管「接着干」的语义是父会话随后自己 `sidecar_send`。
   */
  async attach(input: {
    sessionId: string;
    cwd?: string;
    title?: string;
    signal?: AbortSignal;
  }): Promise<SpawnResult> {
    if (this.disposed) return { ok: false, error: '会话已经关闭，不再接管子会话。' };
    if (input.signal?.aborted) return { ok: false, error: '接管子会话已取消。' };
    const sessionId = input.sessionId.trim();
    if (!sessionId) return { ok: false, error: 'session_id 不能为空。' };
    this.sweep();
    const existing = this.get(sessionId);
    if (existing) return { ok: true, entry: existing };
    const history = readSessionHistory(sessionId, this.sessionsDir());
    if (!history) {
      return {
        ok: false,
        error: `找不到会话 ${sessionId} 的落盘文件（${this.sessionsDir()}）：接管要求这条会话至少跑完过一轮。`,
      };
    }
    // 接管默认回到那条会话自己的目录：接着干的活要落在它原来的工作区里。
    const cwd = resolveSessionCwd(input.cwd?.trim() || history.cwd || this.currentSession().cwd, this.defaultCwd);
    let process_: SidecarProcess;
    try {
      process_ = await this.startProcess({
        cwd,
        resumeSessionId: sessionId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.error('sidecar:attach-failed', { error: message, sessionId });
      return { ok: false, error: `接管失败：${message}` };
    }
    if (this.disposed) {
      await process_.close(0);
      return { ok: false, error: '会话在接管过程中关闭了，子会话没有启动。' };
    }
    const entry: SidecarEntry = {
      id: process_.sessionId ?? sessionId,
      title: input.title?.trim() || history.title,
      cwd: process_.cwd,
      createdAt: Date.now(),
      process: process_,
      seenFinishedTurns: 0,
      attached: true,
    };
    // 历史先进投影再进登记表：`watchEntry` 会把基线设成「当前已完成的轮数」，
    // 顺序反了就会把刚补齐的历史当成新事件再报一遍。
    process_.transcript.seed(history.turns, history.totalTurns);
    this.entries.set(entry.id, entry);
    this.watchEntry(entry);
    this.emit('attach', entry, `已接管这条会话（历史 ${history.totalTurns} 轮，工具调用只保留名字）`);
    this.ctx.logger.info('sidecar:attached', { sessionId: entry.id, turns: history.totalTurns });
    return { ok: true, entry };
  }

  /**
   * 批量收：`all` 收全部，`idle` 收空闲的（还在跑的不动）。
   *
   * 返回真正收掉的 id。收不掉的（找不到）不报错——批量操作里一条过期 id 不该让
   * 其余几条都不生效。
   */
  async closeMany(scope: 'all' | 'idle' | string[]): Promise<string[]> {
    const targets =
      scope === 'all'
        ? this.list()
        : scope === 'idle'
          ? this.list().filter((entry) => !entry.process.transcript.busy && entry.process.transcript.settled)
          : scope.map((id) => this.get(id)).filter((entry): entry is SidecarEntry => Boolean(entry));
    const closed: string[] = [];
    // 串行：每个都想走到 grace 落盘，并行收会让 4 个进程同时抢 CPU。
    for (const entry of targets) {
      if (await this.close(entry.id)) closed.push(entry.id);
    }
    return closed;
  }

  /** 活着的子会话数：面板状态行与 `sidecar_collect` 的收尾建议都用它。 */
  get liveCount(): number {
    return this.liveEntries().length;
  }

  private trackClose(process_: SidecarProcess, graceMs?: number): Promise<void> {
    const closing = process_.close(graceMs);
    this.retiring.add(closing);
    void closing.then(
      () => this.retiring.delete(closing),
      () => this.retiring.delete(closing),
    );
    return closing;
  }

  /** 起一个子进程，并在卸载时能等它结束（不设并发名额）。 */
  private async startProcess(options: SidecarProcessOptions): Promise<SidecarProcess> {
    const signal = options.signal ? AbortSignal.any([this.startup.signal, options.signal]) : this.startup.signal;
    const pending = SidecarProcess.start({ ...options, signal });
    this.pendingStarts.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingStarts.delete(pending);
    }
  }

  /** 还活着的子会话：数目只看登记表，进程已退出的空壳不算。 */
  liveEntries(): SidecarEntry[] {
    return this.list().filter((entry) => !entry.process.closed);
  }

  /** 摘掉多余的死条目，只留最近的 `MAX_DEAD_ENTRIES` 条供回看。 */
  sweep(): void {
    const dead = this.list().filter((entry) => entry.process.closed);
    for (const entry of dead.slice(0, Math.max(0, dead.length - MAX_DEAD_ENTRIES))) {
      this.entries.delete(entry.id);
    }
  }

  /**
   * 收掉全部子会话。
   *
   * `graceMs` 由调用方定：用户主动关（`sidecar_close`）用默认的 3s，让当前那一轮
   * 落盘；进程退出时压到几百毫秒，因为宿主只留了有限的清理预算。
   */
  async closeAll(graceMs?: number): Promise<void> {
    this.disposed = true;
    this.startup.abort();
    const entries = this.list();
    this.entries.clear();
    // 并行收：四个子进程各自等 grace，串行会把退出时间乘上四。
    await Promise.all([
      ...entries.map((entry) => this.trackClose(entry.process, graceMs).catch(() => undefined)),
      ...[...this.retiring].map((closing) => closing.catch(() => undefined)),
      ...[...this.pendingStarts].map((pending) =>
        pending.then(
          (process_) => process_.close(0),
          () => undefined,
        ),
      ),
    ]);
  }
}

/** 开始等待时的完成计数；turn 要等到至少一轮在调用后结束。 */
export type WaitBaseline = {
  /** 调用时已经结束的轮次数（单调，不受保留窗口影响）。 */
  finishedTurns: number;
};

export function waitBaseline(transcript: SidecarTranscript): WaitBaseline {
  return { finishedTurns: transcript.finishedTurnCount };
}

/** `sidecar_wait` 的判定：都基于这一份投影，不需要另外维护状态。 */
export function waitSatisfied(
  transcript: SidecarTranscript,
  until: 'idle' | 'text' | 'turn',
  pattern: RegExp | null,
  baseline: WaitBaseline,
): { done: boolean; detail?: string } {
  if (until === 'idle') {
    // 只看 `busy` 会在「steer 已经投出去、这一轮刚好收尾」的窗口里提前返回：
    // 那条追加的消息马上会另起一轮，此时给出的结果并不含它。
    if (!transcript.settled) return { done: false };
    const latest = transcript.turns.at(-1);
    return { done: true, detail: latest ? `这一轮结束了（${latest.status}）。` : '子会话空闲。' };
  }
  if (until === 'turn') {
    if (!transcript.settled) return { done: false };
    // 用单调计数而不是 `allTurns().length`：等待期间那一轮确实结束了，数量才会
    // 涨；被当前轮的下一迭代吸收时，那一轮结束时同样会涨一次。
    if (transcript.finishedTurnCount <= baseline.finishedTurns) return { done: false };
    return { done: true, detail: `轮次 ${transcript.finishedTurnCount} 已结束。` };
  }
  // text：匹配「最近一轮」的正文，跑着也能命中（否则一个长回答要等到底）。
  const latest = transcript.latestTurn;
  if (!latest || !pattern) return { done: false };
  // 目标可能已在调用前出现，或跨越两次 delta；按工具契约检查最新一轮的完整正文。
  const match = pattern.exec(latest.text);
  return match ? { done: true, detail: `命中：${clip(match[0], 400)}` } : { done: false };
}

export function firstLine(text: string): string {
  return clip(
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || '子会话',
    60,
  );
}

export type { SidecarTurn };
