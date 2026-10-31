import type { PluginContext } from '@packages/mica-plugin/index.js';
import {
  currentSidecarDepth,
  MAX_SIDECAR_DEPTH,
  resolveSessionCwd,
  SidecarProcess,
  type SidecarProcessOptions,
} from './sidecarProcess.js';
import type { SidecarTranscript, SidecarTurn } from './transcript.js';
import { clip } from './views.js';

/** 同时活着的子会话上限：再多就不是「派一个去干活」，而是一个没人收的进程池。 */
export const MAX_SIDECARS = 4;

/**
 * 进程已经退出的条目最多留几条。
 *
 * 死条目不能立刻删：最后一轮的输出与退出原因只在它手里，而用户恰恰是「怎么没动静
 * 了」的时候来查。留最近的几条够用，全留就是一个越攒越大的内存垃圾堆。
 */
export const MAX_DEAD_ENTRIES = 4;

export type SidecarEntry = {
  /** 会话 id（`thread/start` 返回）。第一轮结束前会话文件还不存在。 */
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  process: SidecarProcess;
  /** 上一次整份渲染时的 `transcript.revision`；用来认出「什么都没发生」的重复查询。 */
  seenRevision?: number;
};

export type SpawnResult = { ok: true; entry: SidecarEntry } | { ok: false; error: string };

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
  /**
   * 正在握手、还没进登记表的启动数。
   *
   * 名额必须在 handshake **之前**占住：一个 spinner 里有五个 `sidecar_spawn`
   * 同时进来时，只数登记表里的条目会让五个全过检查——五个进程，上限四个。
   */
  private starting = 0;
  private readonly startup = new AbortController();
  private readonly pendingStarts = new Set<Promise<SidecarProcess>>();
  /** 已从当前会话摘掉、但还没真正退出的进程，卸载时仍须等它们。 */
  private readonly retiring = new Set<Promise<void>>();
  /** 登记表绑定的父会话：会话在同一个 app-server 里换过（resume / 新对话）就不再是它。 */
  private boundParentId: string | null;
  /** 已被回收：还在握手的启动要自己收尾，回收之后也不许再派生。 */
  private disposed = false;

  constructor(
    private readonly ctx: PluginContext,
    private readonly parentSessionId: string | null,
    private readonly defaultCwd: string,
    /**
     * 父会话当前的角色：子会话不指定 role 时沿用它，而不是回到配置默认值。
     * 用函数而不是值——会话里切过角色之后再派，跟的要是切完的那个。
     */
    private readonly currentRole: () => string | undefined,
  ) {
    this.boundParentId = parentSessionId;
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
   * 它们挂在一条已经不存在的会话名下：用户看不到、工具也找不到，却还在占着进程和
   * 并发名额——那正是「没人收的子会话」这件事最隐蔽的一种形态。
   */
  private syncParent(): void {
    const current = this.currentSession().id;
    if (current === this.boundParentId) return;
    this.boundParentId = current;
    const stale = [...this.entries.values()];
    this.entries.clear();
    for (const entry of stale) void this.trackClose(entry.process, 0);
  }

  async spawn(input: {
    prompt: string;
    cwd?: string;
    title?: string;
    role?: string;
    model?: string;
    effort?: string;
    maxTurns?: number;
    signal?: AbortSignal;
  }): Promise<SpawnResult> {
    // 回收之后还派：这个进程马上要退出，派出来的孩子没人管。
    if (this.disposed) return { ok: false, error: '会话已经关闭，不再派生新的子会话。' };
    if (input.signal?.aborted) return { ok: false, error: '派生子会话已取消。' };
    if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns <= 0)) {
      return { ok: false, error: 'max_turns 必须为正整数。' };
    }
    this.sweep();
    // 名额算的是「还活着」的：退了但还没清掉的死条目不该占着并发名额，否则
    // 一个都没跑的时候 spawn 会被拒绝，而列表里其实只有空壳。
    if (this.liveEntries().length + this.starting >= MAX_SIDECARS) {
      return {
        ok: false,
        error: `已经有 ${MAX_SIDECARS} 个子会话在跑，先 sidecar_close 掉不再需要的再开新的。`,
      };
    }
    // 深度上限：每层子会话都是完整的 mica 进程，不限深就是指数级的进程树。
    if (currentSidecarDepth() >= MAX_SIDECAR_DEPTH) {
      return {
        ok: false,
        error: `已经套了 ${MAX_SIDECAR_DEPTH} 层子会话，不再往下派生：每层都是完整进程，再深会拖死机器。这一层请直接自己做完。`,
      };
    }
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
      ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
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
    };
    this.entries.set(id, entry);
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
    await this.trackClose(entry.process);
    this.ctx.logger.info('sidecar:closed', { sessionId: entry.id });
    return true;
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

  /** 起一个子进程，同时占住/释放并发名额（名额从握手开始算）。 */
  private async startProcess(options: SidecarProcessOptions): Promise<SidecarProcess> {
    this.starting += 1;
    const signal = options.signal ? AbortSignal.any([this.startup.signal, options.signal]) : this.startup.signal;
    const pending = SidecarProcess.start({ ...options, signal });
    this.pendingStarts.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingStarts.delete(pending);
      this.starting -= 1;
    }
  }

  /** 还活着的子会话：占用并发名额的是它们，不是进程已经退出的空壳。 */
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
