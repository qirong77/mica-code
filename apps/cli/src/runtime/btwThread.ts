import type { MicaBtwEntry, MicaBtwThread, MicaBtwToolCall } from '@packages/mica-runtime/index.js';
// 直接从子路径取：`@packages/mica-builtin-commands/index.js` 会经 commands/btw.js
// 拖进 Ink/React，而 app-server 是 headless 进程（见 commands/btwThread.ts 的说明）。
import { createBtwThread, type BtwThread } from '@packages/mica-builtin-commands/commands/btwThread.js';
import { recordHelperSubagentUsage } from '@packages/mica-builtin-commands/subagentUsage.js';
import type { CommandAgent, CommandSessionController } from '@packages/mica-builtin-commands/services.js';
import type { AgentQueryContent } from '@packages/mica-agent/index.js';
// 与 headless 的对话输入同一条链路：草稿里的 `[Image](路径)` 要变成多模态内容块，
// 模型才真的看得到图（桌面端 By The Way 的粘贴图片就走这里）。
import { parseImageRefs } from '@packages/mica-ui/utils/imagePaste.js';

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

export class BtwThreadController {
  private readonly options: BtwThreadControllerOptions;

  private threadId = '';

  private entries: MicaBtwEntry[] = [];

  /** 当前线程的子代理（+ 已记账请求数）。重置时丢弃。 */
  private thread: BtwThread | null = null;

  private inFlight = false;

  /** 正在回答的那一条的流式缓冲；没有回答时是 null。 */
  private stream: BtwStream | null = null;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: BtwThreadControllerOptions) {
    this.options = options;
    this.threadId = this.newId();
  }

  snapshot(): MicaBtwThread {
    return {
      id: this.threadId,
      entries: this.entries.map((entry) => ({
        ...entry,
        ...(entry.tools ? { tools: entry.tools.map((tool) => ({ ...tool })) } : {}),
      })),
    };
  }

  /** 另起一条线程：下一次提问会重新取一份主流程对话记录当背景。 */
  reset(): void {
    this.threadId = this.newId();
    this.entries = [];
    this.thread = null;
    // 在途回答的 delta 不该落到新线程上（正常情况下 reset 只会在空闲时被调用）。
    this.clearFlushTimer();
    this.stream = null;
    this.options.onUpdate(this.snapshot());
  }

  /**
   * 收下一个问题并立刻返回；回答**流式**推回（`onUpdate` 会收到多次）。
   *
   * `newThread` 是面板的「新话题」：不带它就是在当前线程上追问（等价 `/btw -continue`）。
   */
  ask(question: string, options: { newThread?: boolean } = {}): { ok: true } | { ok: false; message: string } {
    const text = question.trim();
    if (!text) return { ok: false, message: '问题不能为空' };
    if (this.inFlight) return { ok: false, message: '上一个 By The Way 问题还在回答中，请稍候' };
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
    this.options.onUpdate(this.snapshot());

    void this.run(thread, entry);
    return { ok: true };
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
    let finishedAt = '';
    try {
      // 问题里的 `[Image](路径)` 先解析成多模态内容块：不解析的话粘贴进来的图片对模型
      // 只是一段路径文本。解析失败（文件不在了、格式不支持）由 parseImageRefs 自己降级成
      // `[image omitted: …]` 文本，不会把整条问题弄丢。
      //
      // 只在真的带图片引用时才解析：`await` 一个普通字符串也会让请求推迟一个 microtask，
      // 纯文本问题（CLI、以及绝大多数 btw 提问）没必要为它改变「收下问题就发」的时序。
      let input: AgentQueryContent = entry.question;
      if (input.includes('[Image](')) input = await parseImageRefs(input);
      const reply = await thread.subagent.query(input);
      finishedAt = this.timestamp();
      // 最终正文以 query 的返回值为准（它是完整的多轮迭代结果，含迭代之间的分隔），
      // 流式那份只是过程中看到的。
      this.patchEntry(entry.id, { status: 'completed', answer: reply, finishedAt });
    } catch (error) {
      failed = true;
      finishedAt = this.timestamp();
      this.patchEntry(entry.id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        finishedAt,
      });
    } finally {
      // 最后一次合并：把还压在合并窗口里的思考/工具行落进条目（否则最后 80ms 会丢）。
      // 正文按情况保留——完成时已经有了权威答案，失败时流出来的那部分正是唯一的记录。
      this.settleStream(entry.id, { keepAnswer: !failed });
      this.inFlight = false;
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
            status: failed ? 'failed' : 'completed',
            startedAt: entry.startedAt,
            finishedAt,
          },
        );
      }
      thread.recordedRequests = requests.length;
      this.options.onUpdate(this.snapshot());
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
