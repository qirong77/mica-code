import type { PluginContext } from '@packages/mica-plugin/index.js';
import {
  currentSidecarDepth,
  MAX_SIDECAR_DEPTH,
  SidecarProcess,
  type SidecarProcessOptions,
} from './sidecarProcess.js';
import type { SidecarTranscript, SidecarTurn } from './transcript.js';
import { clip } from './views.js';

/** 同时活着的子会话上限：再多就不是「派一个去干活」，而是一个没人收的进程池。 */
export const MAX_SIDECARS = 4;

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

  constructor(
    private readonly ctx: PluginContext,
    private readonly parentSessionId: string | null,
    private readonly defaultCwd: string,
    /**
     * 父会话当前的角色：子会话不指定 role 时沿用它，而不是回到配置默认值。
     * 用函数而不是值——会话里切过角色之后再派，跟的要是切完的那个。
     */
    private readonly currentRole: () => string | undefined,
  ) {}

  list(): SidecarEntry[] {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): SidecarEntry | null {
    const exact = this.entries.get(id);
    if (exact) return exact;
    // 完整 id 有 36 个字符，模型抄写容易错；唯一前缀等价于它。
    const matches = this.list().filter((entry) => entry.id.startsWith(id));
    return matches.length === 1 ? matches[0]! : null;
  }

  async spawn(input: {
    prompt: string;
    cwd?: string;
    title?: string;
    role?: string;
    model?: string;
    effort?: string;
    maxTurns?: number;
  }): Promise<SpawnResult> {
    if (this.list().length >= MAX_SIDECARS) {
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
    const cwd = input.cwd?.trim() || this.defaultCwd;
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
      ...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
    };

    let process_: SidecarProcess;
    try {
      process_ = await SidecarProcess.start(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.error('sidecar:spawn-failed', { error: message });
      return { ok: false, error: `子会话启动失败：${message}` };
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

    try {
      await process_.send(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 第一句没投出去，这个子会话就是个空壳：收掉，别在侧栏留一条空会话。
      await this.close(id);
      return { ok: false, error: `子会话已启动，但第一句话没投出去：${message}` };
    }
    return { ok: true, entry };
  }

  async close(id: string): Promise<boolean> {
    const entry = this.get(id);
    if (!entry) return false;
    this.entries.delete(entry.id);
    await entry.process.close();
    this.ctx.logger.info('sidecar:closed', { sessionId: entry.id });
    return true;
  }

  /** 进程已经自己退出的条目顺手摘掉，避免 status 里一直挂着死会话。 */
  prune(): void {
    for (const [id, entry] of this.entries) {
      if (entry.process.closed) this.entries.delete(id);
    }
  }

  /**
   * 收掉全部子会话。
   *
   * `graceMs` 由调用方定：用户主动关（`sidecar_close`）用默认的 3s，让当前那一轮
   * 落盘；进程退出时压到几百毫秒，因为宿主只留了有限的清理预算。
   */
  async closeAll(graceMs?: number): Promise<void> {
    const entries = this.list();
    this.entries.clear();
    // 并行收：四个子进程各自等 grace，串行会把退出时间乘上四。
    await Promise.all(entries.map((entry) => entry.process.close(graceMs).catch(() => undefined)));
  }
}

/** `sidecar_wait` 的判定：两种条件都基于这一份投影，不需要另外维护状态。 */
export function waitSatisfied(
  transcript: SidecarTranscript,
  until: 'idle' | 'text' | 'turn',
  pattern: RegExp | null,
  baselineTurns: number,
): { done: boolean; detail?: string } {
  if (until === 'idle') {
    if (transcript.busy) return { done: false };
    const latest = transcript.turns.at(-1);
    return { done: true, detail: latest ? `这一轮结束了（${latest.status}）。` : '子会话空闲。' };
  }
  if (until === 'turn') {
    const turns = transcript.allTurns();
    return turns.length > baselineTurns
      ? { done: !transcript.busy, detail: `轮次 ${turns.length} 已结束。` }
      : { done: false };
  }
  // text：匹配「最近一轮」的正文，跑着也能命中（否则一个长回答要等到底）。
  const latest = transcript.latestTurn;
  if (!latest || !pattern) return { done: false };
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
