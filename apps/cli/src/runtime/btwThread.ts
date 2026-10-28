import type {
  MicaBtwContext,
  MicaBtwEntry,
  MicaBtwThread,
  MicaBtwToolCall,
} from '@packages/mica-runtime/index.js';
// 直接从子路径取：`@packages/mica-builtin-commands/index.js` 会拖进 Ink/React，
// 而 app-server 是 headless 进程（见 shared/btwThread.ts 的说明）。
import { createBtwThread, type BtwThread } from '@packages/mica-builtin-commands/shared/btwThread.js';
import { recordHelperSubagentUsage } from '@packages/mica-builtin-commands/subagentUsage.js';
import type { CommandAgent, CommandSessionController } from '@packages/mica-builtin-commands/services.js';
import type { AgentQueryContent } from '@packages/mica-agent/index.js';
// 与 headless 的对话输入同一条链路：草稿里的 `[Image](路径)` 要变成多模态内容块，
// 模型才真的看得到图（桌面端 By The Way 的粘贴图片就走这里）。
import { parseImageRefs } from '@packages/mica-ui/utils/imagePaste.js';
import { micaContext } from '@packages/mica-context/index.js';
import {
  deleteBtwState,
  readBtwState,
  writeBtwState,
  type StoredBtwThread,
} from '@packages/mica-common/index.js';

/**
 * 常驻 host（`mica app-server`）里的 By The Way（btw）线程。
 *
 * 为什么需要它：桌面端的面板就是 CLI 的 `/btw`（面板里追问 = `/btw -continue`），
 * 而 btw 的会话状态是「一个可复用的隔离子代理」+「已经问过的问答」，两者都只能活在
 * host 进程里（子代理是从 host 的 agent 上拷出来的，「主流程对话记录」也只有 host 知道）。
 *
 * btw 不是「问一句、等一会儿、出一段文字」的黑盒：它就是**一个 mica 运行实例**
 * （隔离子代理跑同一套 agent 循环，可以读文件、搜索、联网），所以这里把子代理的
 * `onText`/`onThinking`/`onToolCall`/`onToolResult` 挂上，按 delta 攒进当前条目、
 * 再按 ~80ms 合并成一份快照推给客户端——抽屉里看到的就是主对话那套实时渲染。
 *
 * 四条约束写在实现里：
 * - **一次只回答一个问题**：复用的是同一个子代理，它的消息数组不是并发安全的；面板
 *   在回答期间也会禁用输入，所以拒绝第二个并发问题不是限制、而是把状态机写清楚。
 * - **不阻塞 host 的请求循环**：`runAppServer` 逐行 `await` 请求，`ask()` 必须立刻返回
 *   （真正的等待在后台 promise 里），否则主流程运行中用户按不动中断/排队。
 * - **快照必须有界**：每次推的都是整条线程，思考/工具输出/正文各有字符上限，而且
 *   思考与工具行**只描述正在发生的那一轮**（新问题开始时上一条的会被清掉）——与主对话的
 *   回合日志同一语义，否则一条长回答能攒出几十万字符、每个 delta 都在推。
 * - **记一次用量**：btw 的请求不属于任何 turn，不记账就会从 Stats 里整块漏掉。
 */
export type BtwThreadControllerOptions = {
  agent: CommandAgent;
  /** host 自己的会话控制器：btw 的用量要写进当前会话，空闲时立刻落盘。 */
  sessionController: CommandSessionController;
  /** 线程有变化就推一次整份快照（含「开始回答」那一帧与每一个流式合并窗口）。 */
  onUpdate: (thread: MicaBtwThread) => void;
  /** 流式合并窗口（毫秒）；测试里调成 0 直接同步推。 */
  flushIntervalMs?: number;
  /**
   * 从磁盘恢复一条已经有内容的线程（`mica/btw/threads` 的持久化）。
   *
   * 只带「已经问过的问答 + 子代理的消息数组」：子代理要到第一次提问时才建，
   * 所以恢复出来的消息先挂起，等建好子代理再灌进它（见 `takeRestoredMessages`）。
   */
  initial?: {
    id?: string;
    entries?: MicaBtwEntry[];
    messages?: unknown[];
  };
};

/**
 * 落盘的 btw 线程。
 *
 * `messages` 是这条线程子代理的消息数组——**它是让「重启后还能接着追问」成立的东西**，
 * 只有问答文本是不够的（模型看不到自己上一轮读过什么）。媒体块在落盘时被丢掉（见
 * `persistableBtwMessages`）：base64 图片能让一个会话文件涨到几十 MB，而重启后那段
 * 上下文本来也不再需要图片本身。
 */
export type MicaBtwStoredThread = {
  id: string;
  entries: MicaBtwEntry[];
  messages: unknown[];
};

/** 面板只需要最近几轮；更早的留在会话里也没有意义（回答本身不落盘）。 */
export const MAX_BTW_ENTRIES = 20;
/** 一次回答里最多保留多少条工具调用（超出后从最早的开始丢）。 */
export const MAX_BTW_TOOLS = 20;
/** 思考正文上限：留最近的部分（正在推理的那一段才是读者在看的）。 */
export const MAX_BTW_THINKING_CHARS = 20_000;
/** 工具输出上限：与桌面端回合日志的折叠粒度同量级即可，全文没有必要跨进程搬。 */
export const MAX_BTW_TOOL_OUTPUT_CHARS = 4_000;
/** 流式正文上限：最终答案以 `query` 的返回值为准，这里只是防止边流边无限涨。 */
export const MAX_BTW_ANSWER_CHARS = 200_000;
/** 默认合并窗口：每来一个 delta 就推一次整条线程会把 stdio/IPC 打满。 */
export const BTW_FLUSH_INTERVAL_MS = 80;

/** 一次回答的流式缓冲：`flush()` 把它并进对应的条目。 */
type BtwStream = {
  entryId: string;
  answer: string;
  thinking: string;
  tools: MicaBtwToolCall[];
};

/** 保头截断（正文用）：模型在开头给结论。 */
export function capBtwHead(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 保尾截断（思考用）：读者关心的是刚刚推出来的那一段。 */
export function capBtwTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/**
 * 工具结果该落在哪一行上。
 *
 * 优先按 id 对（同一批并行调用时结果回来的顺序不保证）；没有 id 时退回到「最后一个
 * 同名且还在跑」的调用，至少不会把输出记到已经结束的调用上。
 */
export function resolveBtwToolIndex(tools: MicaBtwToolCall[], name: string, id?: string): number {
  if (id) {
    const byId = tools.findIndex((tool) => tool.id === id);
    if (byId >= 0) return byId;
  }
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool.tool === name && tool.status === 'running') return index;
  }
  return -1;
}

/** 工具入参（provider 给的是 JSON 文本）解析成对象；解析失败原样包一层。 */
export function parseBtwToolArgs(args: string): unknown {
  const text = String(args ?? '').trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : { value };
  } catch {
    return { value: text };
  }
}

/**
 * 落盘前把消息里的媒体块整条丢掉。
 *
 * 图片/文档在 wire 上是 base64，一条线程只要读过一次图就能让持久化文件涨到几十 MB，
 * 而它换来的是「重启后模型还能看到那张图」——这个收益与代价不成比例。丢的方式是
 * **整条消息丢掉**而不是换成占位符：不同协议的媒体块结构不同（`image_url` /
 * `input_image` / `document`），替换错形状会让下一次请求直接 400，而少一条历史消息
 * 只会让模型少一点背景。问答文本本身留在 `entries` 里，界面上一条都不少。
 */
export function persistableBtwMessages(messages: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const message of messages) {
    const text = JSON.stringify(message ?? null);
    if (!text) continue;
    if (text.includes('"input_image"') || text.includes('"image_url"') || text.includes('"document"'))
      continue;
    kept.push(message);
  }
  return kept;
}

export class BtwThreadController {
  private readonly options: BtwThreadControllerOptions;

  private threadId = '';

  private entries: MicaBtwEntry[] = [];

  /** 当前线程的子代理（+ 已记账请求数）。重置时丢弃。 */
  private thread: BtwThread | null = null;

  private inFlight = false;

  /**
   * 正在回答的那一问的中断句柄（面板的停止按钮）。
   *
   * 每次提问换一个新的：上一问的中断不能顺带打断下一问，而 `AbortController` 一旦
   * abort 就永久是 aborted，复用会让后面每一问开局即被中断。
   */
  private abortController: AbortController | null = null;

  /**
   * 排队中的下一问（回答期间按 Enter/Tab 存进来，当前这一问答完自动接上）。
   *
   * 单槽位、只在内存里：它还没开始跑，重启后丢掉是合理的（不像已经问过的问题
   * 那样有答案可看）。撤回（面板上的 ✕ / shift+←）就是把它取回给输入框。
   */
  private pending: string | null = null;

  /** 正在回答的那一条的流式缓冲；没有回答时是 null。 */
  private stream: BtwStream | null = null;

  /**
   * 上一次本地压缩的估算占用（+ 发生时刻）。
   *
   * 压缩改写的只是子代理自己的消息数组，`lastUsage` 仍描述压缩前那次请求，所以
   * 在下一次真实请求回来之前，界面必须显示这份估算值——否则压完看起来一点没变。
   * 与主会话的 `displayUsage` 同一套「更晚的那一个说了算」语义。
   */
  private compacted: { tokens: number; at: number } | null = null;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** 从磁盘恢复、还没灌进子代理的消息（子代理到第一次提问时才存在）。 */
  private restoredMessages: unknown[] | null = null;

  constructor(options: BtwThreadControllerOptions) {
    this.options = options;
    this.threadId = options.initial?.id || this.newId();
    if (options.initial?.entries)
      this.entries = options.initial.entries.map((entry) => ({
        ...entry,
        ...(entry.tools ? { tools: entry.tools.map((tool) => ({ ...tool })) } : {}),
      }));
    const restored = options.initial?.messages;
    if (Array.isArray(restored) && restored.length > 0) this.restoredMessages = [...restored];
  }

  get id(): string {
    return this.threadId;
  }

  /**
   * 接上一份从磁盘读回来的状态（`BtwThreads.restore` 用）。
   *
   * 只接受**还没被用过**的线程：一旦已经问过（或正在回答），历史以子代理为准，
   * 再灌一份磁盘上的会把它覆盖成旧内容。
   */
  adopt(state: MicaBtwStoredThread): void {
    if (this.thread || this.inFlight) return;
    if (Array.isArray(state.entries) && state.entries.length > 0)
      this.entries = state.entries.map((entry) => ({
        ...entry,
        ...(entry.tools ? { tools: entry.tools.map((tool) => ({ ...tool })) } : {}),
      }));
    if (Array.isArray(state.messages) && state.messages.length > 0)
      this.restoredMessages = [...state.messages];
  }

  /** 正在回答（关掉 tab 时不能把它连人带答案一起丢掉）。 */
  get running(): boolean {
    return this.inFlight;
  }

  /**
   * 落盘用的状态：问答 + 子代理消息。
   *
   * `messages` 优先取子代理的实时快照；还没提过问（或刚恢复还没灌回去）时用恢复时
   * 拿到的那份，避免「重启后立刻又存一次空历史」把上次的上下文抹掉。
   */
  exportState(): MicaBtwStoredThread {
    const snapshot = this.thread?.subagent.getSnapshot?.();
    const messages = Array.isArray(snapshot?.messages)
      ? snapshot.messages
      : (this.restoredMessages ?? []);
    return {
      id: this.threadId,
      entries: this.entries.map((entry) => ({
        ...entry,
        ...(entry.tools ? { tools: entry.tools.map((tool) => ({ ...tool })) } : {}),
      })),
      messages: persistableBtwMessages(messages),
    };
  }

  snapshot(): MicaBtwThread {
    const context = this.context();
    return {
      id: this.threadId,
      entries: this.entries.map((entry) => ({
        ...entry,
        ...(entry.tools ? { tools: entry.tools.map((tool) => ({ ...tool })) } : {}),
      })),
      ...(context ? { context } : {}),
      ...(this.pending ? { pendingQuestion: this.pending } : {}),
    };
  }

  /**
   * 这条线程的模型与上下文占用。
   *
   * `tokens` 取**最近一次请求**的 input（= 当前上下文占用，与桌面状态栏同一口径，
   * 用累计值会随轮次线性上涨）。本地压缩之后到下一次请求之前改用压缩的估算值。
   */
  private context(): MicaBtwContext | null {
    const subagent = this.thread?.subagent;
    if (!subagent) return null;
    const usage = Array.isArray(subagent.usageHistory) ? subagent.usageHistory : [];
    const config = this.options.agent.config;
    const last = subagent.lastUsage ?? usage[usage.length - 1];
    const lastAt = Date.parse(last?.occurredAt ?? '');
    const compactedFresh = Boolean(
      this.compacted && (!Number.isFinite(lastAt) || this.compacted.at > lastAt),
    );
    return {
      ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
      ...(config.provider?.id ? { providerId: config.provider.id } : {}),
      ...(compactedFresh
        ? { tokens: this.compacted!.tokens, estimated: true }
        : Number.isFinite(last?.inputTokens)
          ? { tokens: last!.inputTokens }
          : {}),
      ...(Number.isFinite(last?.cachedInputTokens)
        ? { cachedTokens: last!.cachedInputTokens }
        : {}),
      ...(Number.isFinite(config.provider?.contextWindowSize)
        ? { contextWindowSize: config.provider.contextWindowSize }
        : {}),
      requests: usage.length,
      totalInputTokens: usage.reduce((sum, record) => sum + (Number(record.inputTokens) || 0), 0),
      totalOutputTokens: usage.reduce((sum, record) => sum + (Number(record.outputTokens) || 0), 0),
    };
  }

  /** 另起一条线程：下一次提问会重新取一份主流程对话记录当背景。 */
  reset(): void {
    this.threadId = this.newId();
    this.entries = [];
    this.thread = null;
    this.compacted = null;
    // 排队那一问属于上一条线程的问题，换线程就没了意义（否则新线程会莫名其妙
    // 自己开答一句用户在上一个话题里排的话）。
    this.pending = null;
    // 在途回答的 delta 不该落到新线程上（正常情况下 reset 只会在空闲时被调用）。
    this.clearFlushTimer();
    this.stream = null;
    this.options.onUpdate(this.snapshot());
  }

  /**
   * 本地快速压缩这条线程自己的历史（同 `/compact` 的 `toolResultsOnly`）：
   * 把工具结果、媒体块与工具参数里的正文换成占位符/摘要，**不调用模型、不丢轮次**，
   * 可重复执行。
   *
   * 为什么必须由 host 做：btw 线程是一个复用的子代理，它的消息数组只活在这个进程里
   * （既不落盘也不属于会话快照），客户端没有任何入口能改它。
   */
  async compact(): Promise<
    | { ok: true; savedTokens: number; tokens: number; requests: number }
    | { ok: false; message: string }
  > {
    if (this.inFlight) return { ok: false, message: '正在回答中，等这一条答完再压缩' };
    const subagent = this.thread?.subagent;
    const snapshot = subagent?.getSnapshot?.();
    if (!subagent || !snapshot || typeof subagent.loadSnapshot !== 'function')
      return { ok: false, message: '这条 By The Way 线程还没有可压缩的对话' };
    try {
      const result = await new micaContext.CompactionService().compact({
        messages: snapshot.messages,
        options: { toolResultsOnly: true },
      });
      subagent.loadSnapshot({ ...snapshot, messages: result.messages });
      // 压缩后到下一次真实请求之前，界面读这份估算（lastUsage 描述的是压缩前那次）。
      this.compacted = { tokens: result.afterTokenEstimate, at: Date.now() };
      this.options.onUpdate(this.snapshot());
      return {
        ok: true,
        savedTokens: result.savedTokenEstimate,
        tokens: result.afterTokenEstimate,
        requests: Array.isArray(subagent.usageHistory) ? subagent.usageHistory.length : 0,
      };
    } catch (error) {
      if (micaContext.isCompactionNotNeededError(error))
        return { ok: false, message: '没有可清理的工具结果或图片，暂不需要压缩' };
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 收下一个问题并立刻返回；回答**流式**推回（`onUpdate` 会收到多次）。
   *
   * `newThread` 是面板的「新话题」：不带它就是在当前线程上追问（等价 `/btw -continue`）。
   */
  ask(
    question: string,
    options: { newThread?: boolean; queue?: boolean } = {},
  ): { ok: true } | { ok: false; message: string } {
    const text = question.trim();
    if (!text) return { ok: false, message: '问题不能为空' };
    if (this.inFlight) {
      // 排队：面板在回答期间按 Enter/Tab 就走这里，当前这一问答完自动接上。
      // 只留一个槽位（与主对话的 message-queue 同款）——btw 是「顺手问一句」，
      // 攒一串问题反而看不懂它到底在答哪个。`newThread` 期间排队没有意义
      // （换线程会丢掉正在跑的那条的上下文），如实拒绝。
      if (!options.queue || options.newThread)
        return { ok: false, message: '上一个 By The Way 问题还在回答中，请稍候' };
      if (this.pending) return { ok: false, message: '已经有一条排队中的问题了' };
      this.pending = text;
      this.options.onUpdate(this.snapshot());
      return { ok: true };
    }
    if (options.newThread) {
      this.threadId = this.newId();
      this.entries = [];
      this.thread = null;
    }

    if (!this.thread) {
      try {
        this.thread = createBtwThread(this.options.agent);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      this.applyRestoredMessages(this.thread);
    }
    const thread = this.thread;

    const entry: MicaBtwEntry = {
      id: this.newId(),
      question: text,
      status: 'running',
      startedAt: this.timestamp(),
      finishedAt: null,
    };
    // 上一轮的思考与工具日志随新一轮开始退场：日志描述的是「正在发生的那一轮」，
    // 与主对话的回合日志同一语义（完成后的回答留在 entries 里，不会丢）。
    this.entries = [...this.dropStreamFields(this.entries), entry].slice(-MAX_BTW_ENTRIES);
    this.stream = { entryId: entry.id, answer: '', thinking: '', tools: [] };
    this.attachStreaming(thread);
    this.inFlight = true;
    this.abortController = new AbortController();
    this.options.onUpdate(this.snapshot());

    void this.run(thread, entry);
    return { ok: true };
  }

  /**
   * 停止正在回答的那一问（面板的停止按钮）。
   *
   * 只发中断信号、立刻返回：真正的收尾（写 `aborted` 状态、记账、补历史）在 `run`
   * 的 catch/finally 里做——那里才是唯一知道这一问跑到哪一步的地方。
   */
  interrupt(): { ok: true } | { ok: false; message: string } {
    if (!this.inFlight || !this.abortController) return { ok: false, message: '当前没有正在回答的问题' };
    this.abortController.abort();
    return { ok: true };
  }

  /**
   * 撤回排队中的问题（面板上的 ✕，等价主对话的 shift+←）。
   *
   * 只清槽、不启动任何东西：排队那一问还没进模型，撤回是安全的。
   */
  recall(): { ok: true; question: string } | { ok: false; message: string } {
    const question = this.pending;
    if (!question) return { ok: false, message: '没有排队中的问题' };
    this.pending = null;
    this.options.onUpdate(this.snapshot());
    return { ok: true, question };
  }

  /**
   * 把从磁盘恢复的消息灌回新建的子代理。
   *
   * 只在**新建子代理时**做一次，而且必须在第一次 `query` 之前：灌晚了模型会先看到
   * 空历史、按「新问题」回答，恢复出来的上下文就白存了。失败不抛——恢复不了上下文
   * 顶多让这一问少点背景，不能让整条线程用不了。
   */
  private applyRestoredMessages(thread: BtwThread): void {
    const messages = this.restoredMessages;
    this.restoredMessages = null;
    if (!messages || messages.length === 0) return;
    const subagent = thread.subagent;
    const snapshot = subagent.getSnapshot?.();
    if (!snapshot || typeof subagent.loadSnapshot !== 'function') return;
    try {
      subagent.loadSnapshot({ ...snapshot, messages });
    } catch {
      // 老版本的快照形状不兼容时按新线程继续（answers 仍能看到，只是模型没有背景）
    }
  }

  /** 把子代理的流式回调接到当前这一条上（复用同一个子代理，所以每次提问都重接）。 */
  private attachStreaming(thread: BtwThread): void {
    const subagent = thread.subagent;
    subagent.onText = (text) => {
      const stream = this.stream;
      if (!stream || !text) return;
      stream.answer = capBtwHead(stream.answer + text, MAX_BTW_ANSWER_CHARS);
      this.scheduleFlush();
    };
    subagent.onThinking = (text) => {
      const stream = this.stream;
      if (!stream || !text) return;
      stream.thinking = capBtwTail(stream.thinking + text, MAX_BTW_THINKING_CHARS);
      this.scheduleFlush();
    };
    subagent.onToolCall = (name, args, id) => this.beginTool(name, args, id);
    subagent.onToolResult = (name, result, id) => this.finishTool(name, result, id);
  }

  private beginTool(name: string, args: string, id?: string): void {
    const stream = this.stream;
    if (!stream) return;
    const callId = id || `${name}#${stream.tools.length + 1}`;
    const tool: MicaBtwToolCall = {
      id: callId,
      tool: name,
      input: parseBtwToolArgs(args),
      status: 'running',
      startedAt: this.timestamp(),
      finishedAt: null,
    };
    stream.tools = [...stream.tools.filter((item) => item.id !== callId), tool].slice(-MAX_BTW_TOOLS);
    this.scheduleFlush();
  }

  private finishTool(name: string, result: string, id?: string): void {
    const stream = this.stream;
    if (!stream) return;
    const index = resolveBtwToolIndex(stream.tools, name, id);
    if (index < 0) return;
    const finishedAt = this.timestamp();
    stream.tools = stream.tools.map((tool, current) =>
      current === index
        ? {
            ...tool,
            status: 'completed',
            output: capBtwHead(result, MAX_BTW_TOOL_OUTPUT_CHARS),
            finishedAt,
          }
        : tool,
    );
    this.scheduleFlush();
  }

  private async run(thread: BtwThread, entry: MicaBtwEntry): Promise<void> {
    // 别从 entry 上读结果：patchEntry 是替换式的，入参那个对象不会跟着变。
    let failed = false;
    let aborted = false;
    let finishedAt = '';
    let abortedInput: AgentQueryContent | null = null;
    try {
      // 问题里的 `[Image](路径)` 先解析成多模态内容块：不解析的话粘贴进来的图片对模型
      // 只是一段路径文本。解析失败（文件不在了、格式不支持）由 parseImageRefs 自己降级成
      // `[image omitted: …]` 文本，不会把整条问题弄丢。
      //
      // 只在真的带图片引用时才解析：`await` 一个普通字符串也会让请求推迟一个 microtask，
      // 纯文本问题（CLI、以及绝大多数 btw 提问）没必要为它改变「收下问题就发」的时序。
      let input: AgentQueryContent = entry.question;
      if (input.includes('[Image](')) input = await parseImageRefs(input);
      abortedInput = input;
      const signal = this.abortController?.signal;
      const reply = await thread.subagent.query(input, signal ? { signal } : undefined);
      finishedAt = this.timestamp();
      // 最终正文以 query 的返回值为准（它是完整的多轮迭代结果，含迭代之间的分隔），
      // 流式那份只是过程中看到的。
      this.patchEntry(entry.id, { status: 'completed', answer: reply, finishedAt });
    } catch (error) {
      // 用户主动停止不是失败：已经流出来的那半段就是这一问的答案，界面上也不该显示成报错。
      aborted = this.abortController?.signal.aborted === true;
      failed = true;
      finishedAt = this.timestamp();
      if (aborted) {
        const partial = this.stream?.entryId === entry.id ? this.stream.answer : '';
        this.patchEntry(entry.id, {
          status: 'aborted',
          ...(partial ? { answer: partial } : {}),
          finishedAt,
        });
        // 中断的那一轮可能一次迭代都没提交，历史里没有这次的用户消息；补回去，
        // 否则下一次追问时模型看不到刚才问过什么（与主对话的 abort 同一条路径）。
        try {
          thread.subagent.preserveAbortedTurn?.(abortedInput ?? entry.question, partial);
        } catch {
          // 补历史失败不影响这一问的展示
        }
      } else {
      this.patchEntry(entry.id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        finishedAt,
      });
      }
    } finally {
      // 最后一次合并：把还压在合并窗口里的思考/工具行落进条目（否则最后 80ms 会丢）。
      // 正文按情况保留——完成时已经有了权威答案，失败时流出来的那部分正是唯一的记录。
      this.settleStream(entry.id, { keepAnswer: !failed || aborted });
      this.inFlight = false;
      this.abortController = null;
      // btw 的请求不属于任何 turn，也不进主流程的 usageHistory：只有这里能记账。
      const requests = thread.subagent.usageHistory ?? [];
      if (requests.length > thread.recordedRequests) {
        recordHelperSubagentUsage(
          this.options.agent,
          { getCurrentSessionController: () => this.options.sessionController },
          requests.slice(thread.recordedRequests),
          {
            taskId: 'btw',
            subagentType: 'btw',
            description: entry.question,
            model: this.options.agent.config.model,
            effort: 'none',
            // 中断的那一问仍产生了真实请求：按 `partial` 记账（它不是失败，也不完整）。
            status: aborted ? 'partial' : failed ? 'failed' : 'completed',
            startedAt: entry.startedAt,
            finishedAt,
          },
        );
      }
      thread.recordedRequests = requests.length;
      this.options.onUpdate(this.snapshot());
      // 排队的那一问在本条答完后再发（单槽位，见 ask 的说明）。
      const queued = this.pending;
      if (queued) {
        this.pending = null;
        this.ask(queued);
      }
    }
  }

  /** 合并窗口到期后把流式内容并进正在跑的那一条。 */
  private flush(): void {
    const stream = this.stream;
    if (!stream) return;
    const index = this.entries.findIndex((entry) => entry.id === stream.entryId);
    // 只在「这一条还在跑」时合并：跑完后 run() 已经写入了最终值，迟到的 delta 不该改回去。
    if (index < 0 || this.entries[index].status !== 'running') return;
    this.mergeStream(stream);
    this.options.onUpdate(this.snapshot());
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const interval = this.options.flushIntervalMs ?? BTW_FLUSH_INTERVAL_MS;
    if (interval <= 0) {
      this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, interval);
    // 定时器不该拖住进程退出（host 结束时 stdio 已经关了）。
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** 回答收尾：清掉定时器与流式缓冲，并把攒下的内容并进条目。 */
  private settleStream(entryId: string, options: { keepAnswer: boolean }): void {
    const stream = this.stream;
    this.clearFlushTimer();
    if (stream && stream.entryId === entryId) {
      this.mergeStream(stream, options);
    }
    this.stream = null;
  }

  private mergeStream(stream: BtwStream, options: { keepAnswer?: boolean } = {}): void {
    this.entries = this.entries.map((entry) => {
      if (entry.id !== stream.entryId) return entry;
      const next: MicaBtwEntry = { ...entry };
      if (stream.answer && !options.keepAnswer) next.answer = stream.answer;
      if (stream.thinking) next.thinking = stream.thinking;
      if (stream.tools.length > 0) next.tools = stream.tools.map((tool) => ({ ...tool }));
      return next;
    });
  }

  private dropStreamFields(entries: MicaBtwEntry[]): MicaBtwEntry[] {
    return entries.map((entry) => {
      if (entry.thinking === undefined && entry.tools === undefined) return entry;
      const next = { ...entry };
      delete next.thinking;
      delete next.tools;
      return next;
    });
  }

  private patchEntry(id: string, patch: Partial<MicaBtwEntry>): void {
    this.entries = this.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  }

  private newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}

/**
 * 一个会话下的多条 btw 线程 —— 桌面端抽屉里的多个 tab。
 *
 * 每个 tab 是**一条独立的线程**：自己的子代理、自己的上下文、自己的问答。这正是
 * 「同时问两件不相干的事」需要的隔离（同一条线程里追问会互相污染上下文），也是
 * CLI `/btw -continue` 与「新话题」的关系在桌面端的自然展开：以前只有一条线程，
 * 换话题就得把上一条丢掉；现在只是再开一个 tab。
 *
 * 三条边界：
 * - **一定有上限**：一个 tab 一个子代理、一份消息数组，无上限地开会把 host 的内存吃光。
 *   超出时淘汰最早、且不在回答中的那条（正在回答的绝不淘汰）。
 * - **持久化是整份覆盖**：状态只有几十 KB，按会话存一个文件，`flush` 时才写；
 *   失败只记 stderr——btw 是辅助能力，不能因为存不下来就让问答失败。
 * - **不碰 turn 生命周期**：问答照旧与主流程完全无关（见 chat.js 的 chat:btw-ask）。
 */
export const MAX_BTW_THREADS = 6;

/**
 * 落盘位置与读写逻辑在 `@packages/mica-common/btwState.js`：
 * `SessionStore.delete` 也要清同一个文件，而它在 `mica-session` 里，不能反向依赖
 * 这个（会拖进 Ink 与 builtin commands 的）模块。这里只是转发并绑定类型。
 */
export const readStoredBtwThreads = (sessionId: string): MicaBtwStoredThread[] =>
  readBtwState(sessionId) as MicaBtwStoredThread[];

export const writeStoredBtwThreads = (sessionId: string, threads: MicaBtwStoredThread[]): void =>
  writeBtwState(sessionId, threads as StoredBtwThread[]);

export { deleteBtwState as deleteStoredBtwThreads };

export type BtwThreadsOptions = {
  agent: CommandAgent;
  sessionController: CommandSessionController;
  /** 任意一条线程有变化就推一次它自己的整份快照（客户端按 `thread.id` 归位）。 */
  onUpdate: (thread: MicaBtwThread) => void;
  /** 落盘（整份覆盖）；不传就是不持久化。 */
  onPersist?: (threads: MicaBtwStoredThread[]) => void;
  flushIntervalMs?: number;
};

/** 落盘去抖：一次回答会推几十次快照，每次都写盘既没必要也会拖慢流式。 */
const BTW_PERSIST_DEBOUNCE_MS = 500;

export class BtwThreads {
  private readonly options: BtwThreadsOptions;

  private readonly controllers = new Map<string, BtwThreadController>();

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: BtwThreadsOptions) {
    this.options = options;
  }

  list(): MicaBtwThread[] {
    return [...this.controllers.values()].map((controller) => controller.snapshot());
  }

  /**
   * 取一条线程；`threadId` 为空（或 host 里已经没有它，例如 host 重启过）时新建。
   *
   * 「带回来的 id 在 host 里找不到」按**同一个 id 重建**：客户端觉得那个 tab 还在，
   * 重建出来的空线程至少能让它继续提问，而不是报错或悄悄把问题发到别的 tab 上。
   */
  ensure(threadId?: string | null): BtwThreadController {
    const id = typeof threadId === 'string' ? threadId.trim() : '';
    const existing = id ? this.controllers.get(id) : null;
    if (existing) return existing;
    const controller = new BtwThreadController({
      agent: this.options.agent,
      sessionController: this.options.sessionController,
      flushIntervalMs: this.options.flushIntervalMs,
      ...(id ? { initial: { id } } : {}),
      onUpdate: (thread) => {
        this.options.onUpdate(thread);
        this.schedulePersist();
      },
    });
    this.controllers.set(controller.id, controller);
    this.evict();
    return controller;
  }

  /**
   * 提问。返回的 `threadId` 是**真正收下这个问题的线程**（客户端可能没带 id，
   * 或者带了的是一个刚被淘汰/重启丢掉的 id），tab 就按它归位。
   */
  ask(
    threadId: string | null | undefined,
    question: string,
    options: { queue?: boolean } = {},
  ): { ok: true; threadId: string } | { ok: false; message: string } {
    const controller = this.ensure(threadId);
    const result = controller.ask(question, options);
    if (!result.ok) return result;
    return { ok: true, threadId: controller.id };
  }

  compact(threadId?: string | null) {
    const id = typeof threadId === 'string' ? threadId.trim() : '';
    const controller = id ? this.controllers.get(id) : null;
    if (!controller) return Promise.resolve({ ok: false as const, message: '这条线程已经不存在了' });
    return controller.compact();
  }

  /** 停止某条线程正在回答的那一问（面板输入条的停止按钮）。 */
  interrupt(threadId?: string | null): { ok: true } | { ok: false; message: string } {
    const id = typeof threadId === 'string' ? threadId.trim() : '';
    const controller = id ? this.controllers.get(id) : null;
    if (!controller) return { ok: false, message: '这条线程已经不存在了' };
    return controller.interrupt();
  }

  /** 撤回某条线程排队中的问题（面板上排队条的 ✕）。 */
  recall(threadId?: string | null): { ok: true; question: string } | { ok: false; message: string } {
    const id = typeof threadId === 'string' ? threadId.trim() : '';
    const controller = id ? this.controllers.get(id) : null;
    if (!controller) return { ok: false, message: '这条线程已经不存在了' };
    return controller.recall();
  }

  /** 关掉一个 tab。正在回答的那条拒绝（否则答案会连同宿主一起消失）。 */
  close(threadId?: string | null): { ok: true } | { ok: false; message: string } {
    const id = typeof threadId === 'string' ? threadId.trim() : '';
    const controller = id ? this.controllers.get(id) : null;
    if (!controller) return { ok: true };
    if (controller.running) return { ok: false, message: '这条线程还在回答中，等它答完再关' };
    this.controllers.delete(id);
    this.schedulePersist();
    return { ok: true };
  }

  /** 从磁盘恢复（host 启动时调一次）；坏数据一律忽略。 */
  restore(stored: MicaBtwStoredThread[] | null | undefined): void {
    if (!Array.isArray(stored)) return;
    for (const item of stored) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      if (this.controllers.has(item.id)) continue;
      const controller = this.ensure(item.id);
      // ensure 只带 id；entries 与消息要在这里灌进去（顺序不能反：先建成一条空线程）。
      controller.adopt(item);
      if (this.controllers.size >= MAX_BTW_THREADS) break;
    }
  }

  exportState(): MicaBtwStoredThread[] {
    return [...this.controllers.values()].map((controller) => controller.exportState());
  }

  /** 立刻落盘（host 退出前调，别把最后 500ms 的回答丢掉）。 */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.options.onPersist) return;
    try {
      this.options.onPersist(this.exportState());
    } catch {
      // 存不下来不影响问答（见类型说明）。
    }
  }

  private schedulePersist(): void {
    if (!this.options.onPersist || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, BTW_PERSIST_DEBOUNCE_MS);
    (this.persistTimer as { unref?: () => void }).unref?.();
  }

  /** 淘汰最早、且不在回答中的线程（回答中的绝不能丢）。 */
  private evict(): void {
    while (this.controllers.size > MAX_BTW_THREADS) {
      const victim = [...this.controllers.values()].find((controller) => !controller.running);
      if (!victim) return;
      this.controllers.delete(victim.id);
    }
  }
}
