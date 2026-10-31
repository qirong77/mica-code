/**
 * 把一个 sidecar（子会话）的 app-server 通知流投影成「轮次 → 正文 + 工具行」。
 *
 * 只保留给人看和给模型读的那一层：正文、思考、工具调用的标题与结果、用量。
 * 协议细节（item id、delta 合并、completed 覆盖）都在这里收敛，工具层不必知道
 * Codex 通知长什么样——`mica app-server` 的通知格式变了只改这个文件。
 */

export type SidecarToolCall = {
  id: string;
  title: string;
  /**
   * `interrupted` 是「这一轮被打断时它还没结束」。
   *
   * 不能并进 `completed`：被打断的 `sleep 60` 显示成已完成，读的人会以为命令
   * 正常跑完了，从而得出「测试通过」这样的结论。
   */
  status: 'running' | 'completed' | 'error' | 'interrupted';
  output?: string;
};

export type SidecarTurnStatus = 'running' | 'completed' | 'interrupted' | 'failed';

/**
 * 我们投进子会话的一条用户消息。
 *
 * 单独存是因为它**不来自**通知流：`turn/start` / `turn/steer` 的入参只有父会话知道。
 * 少了它，「提取对话」就只剩助手那一半，读起来像在自言自语。
 */
export type SidecarUserInput = {
  id: number;
  text: string;
};

export type SidecarTurn = {
  id: string;
  status: SidecarTurnStatus;
  text: string;
  thinking: string;
  tools: SidecarToolCall[];
  /** 引发这一轮（或在其中追加）的用户消息，按投递顺序。 */
  userInputs: SidecarUserInput[];
  /** 单轮追加过多时，省略的早期消息数。 */
  omittedUserInputs?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

export type SidecarUsage = {
  input: number;
  output: number;
  total: number;
  /** 最近一次请求的上下文占用（与主对话状态栏同一口径）。 */
  contextTokens: number;
};

type Notification = { method?: unknown; params?: Record<string, unknown> };

/** 保留的轮次上限：子会话是给人回看的，不是审计日志。 */
const MAX_TURNS = 20;
/** 单轮正文/输出的保留上限，避免一个 sidecar 把父会话的上下文撑爆。 */
const MAX_TEXT = 24_000;
const MAX_TOOL_OUTPUT = 4_000;
/**
 * 单轮保留的工具条数。渲染只取最近 8 条，留两倍余量够翻看；不设上限时，
 * 一个跑了几十条命令的子会话会把这些输出全攒在父进程内存里。
 * 命令是串行执行的，所以被丢掉的必然已经结束，不会丢一条仍在跑的输出。
 */
const MAX_TOOLS = 20;
/**
 * 还没有归属轮次的消息上限。投出去但这一轮还没 start 的这段时间里它们停在这里；
 * 正常情况只有一条，多余的是投递失败没清掉的残留，别让它们无限攒。
 */
const MAX_PENDING_INPUTS = 5;
/** 单条用户消息的保留上限：投进去的是提示词，不是附件。 */
const MAX_INPUT_TEXT = 8_000;
/** 长任务的同一轮可能消费很多追加消息，归属之后也需要有保留上限。 */
const MAX_TURN_INPUTS = 20;

/** 工具条数超出上限时丢掉最早的（保留最近的那些）。 */
function trimTools(tools: SidecarToolCall[]): void {
  while (tools.length > MAX_TOOLS) tools.shift();
}

function clamp(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…[截断 ${value.length - limit} 字符]`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class SidecarTranscript {
  readonly turns: SidecarTurn[] = [];
  usage: SidecarUsage = { input: 0, output: 0, total: 0, contextTokens: 0 };
  /** 最近一条 host 警告（provider 重试、MCP 初始化失败等），读的时候清空。 */
  lastWarning = '';
  /**
   * 每有一次可见变化就 +1（不随 `lastWarning` 清空）。
   *
   * 父会话反复查进度是这个能力的常态，而每次渲染都是几千字符的工具输出、直接进
   * 父会话的上下文。有了这个计数，`sidecar_status` 才能认出「什么都没发生」并只回
   * 一行——否则一次 poll 就是一次全量投影，十次就把上下文吃光。
   */
  revision = 0;

  private current: SidecarTurn | null = null;
  private pendingInputs: SidecarUserInput[] = [];
  private nextInputId = 1;
  /**
   * 正文/思考已经到上限，后面的 delta 直接丢掉。
   *
   * 少了这个标志位，每个 delta 都要把整段正文复制一遍再截断：一段 24k 字符的长
   * 回答有几千个 delta，光拼接就要复制几百 MB，而复制出来的部分马上被切掉。
   */
  private textOverflow = false;
  private thinkingOverflow = false;
  /** 单调递增的「已结束轮次」计数：`turns` 会被 `MAX_TURNS` 截断，长度不能当基线。 */
  private finishedTurns = 0;

  /**
   * 记下即将投递的一条用户消息，返回撤销用的 token。
   *
   * 必须在真正发请求**之前**调用：`turn/started` 通知可能比请求的响应更早到达 stdout，
   * 事后补记就会把这条消息挂到下一轮去。发失败时用 `dropUserInput` 撤掉。
   *
   * **只进待归属队列，不直接挂到当前轮**。`turn/steer` 在宿主里是
   * `queueMode: 'after_iteration'`：同一条消息可能被吞进当前轮的下一迭代，也可能因为这一轮
   * 已经结束而变成新的一轮——发出去的那一刻无从判断，只能等消费信号（见下面
   * `mica/queue/dequeue`）或下一轮开始时再归属。
   */
  recordUserInput(text: string): number {
    const id = this.nextInputId++;
    const input: SidecarUserInput = { id, text: clamp(String(text ?? ''), MAX_INPUT_TEXT) };
    this.pendingInputs.push(input);
    if (this.pendingInputs.length > MAX_PENDING_INPUTS) this.pendingInputs.shift();
    this.revision += 1;
    return id;
  }

  /** 投递失败时撤销：留着它会让下一轮凭空多出一条用户没说过的话。 */
  dropUserInput(id: number): void {
    this.pendingInputs = this.pendingInputs.filter((input) => input.id !== id);
    if (this.current) this.current.userInputs = this.current.userInputs.filter((input) => input.id !== id);
    this.revision += 1;
  }

  /**
   * 宿主把排队消息取走消费时调用：此刻还在跑的那一轮就是它真正落进去的那一轮。
   *
   * 返回是否归属成功。没有当前轮说明这一轮已经结束、消息要等下一个 `turn/started`——
   * 那就留在待归属队列里，别硬塞给已经收尾的上一轮。
   */
  claimQueuedInput(text: string): boolean {
    if (!this.current) return false;
    const value = clamp(String(text ?? ''), MAX_INPUT_TEXT);
    // 从最近的往回找：同一句话重复投递时，被消费的是最早那条。
    const index = this.pendingInputs.findIndex((input) => input.text === value);
    if (index < 0) return false;
    const [input] = this.pendingInputs.splice(index, 1);
    if (!input) return false;
    this.current.userInputs.push(input);
    const excess = this.current.userInputs.length - MAX_TURN_INPUTS;
    if (excess > 0) {
      this.current.userInputs.splice(0, excess);
      this.current.omittedUserInputs = (this.current.omittedUserInputs ?? 0) + excess;
    }
    this.revision += 1;
    return true;
  }

  /** 新建轮次时把待归属的消息收进去。 */
  private takePendingInputs(): SidecarUserInput[] {
    if (!this.pendingInputs.length) return [];
    const taken = this.pendingInputs;
    this.pendingInputs = [];
    return taken;
  }

  get busy(): boolean {
    return this.current?.status === 'running';
  }

  /**
   * 投出去但还没被宿主消费的消息数。
   *
   * `steer` 是 `after_iteration` 注入：投出去的那一刻它既可能落进当前轮，也可能
   * 要等这一轮结束后另起一轮。这期间 `busy` 可能为 false，但它显然还没干完活——
   * 只看 `busy` 的等待会在这一轮结束时提前返回，拿到的是不含这条追加的结果。
   */
  get pendingInputCount(): number {
    return this.pendingInputs.length;
  }

  /** 已结束的轮次数（含被 `MAX_TURNS` 丢掉的那些）。 */
  get finishedTurnCount(): number {
    return this.finishedTurns;
  }

  /** 含当前轮次的累计计数，不能用保留窗口长度代替。 */
  get totalTurnCount(): number {
    return this.finishedTurns + (this.current ? 1 : 0);
  }

  get omittedTurnCount(): number {
    return this.finishedTurns - this.turns.length;
  }

  /** 真正停下来：没有在跑的轮次，也没有还没被消费的投递。 */
  get settled(): boolean {
    return !this.busy && this.pendingInputs.length === 0;
  }

  get activeTurn(): SidecarTurn | null {
    return this.current;
  }

  /** 最后一轮（含正在跑的那一轮）。 */
  get latestTurn(): SidecarTurn | null {
    return this.current ?? this.turns.at(-1) ?? null;
  }

  /** 当前这一轮的 id：`turn/steer` 要用它做期望值。 */
  get activeTurnId(): string | null {
    return this.current?.status === 'running' ? this.current.id : null;
  }

  /** 已完成的轮次 + 正在跑的那一轮（未完成的排在最后）。 */
  allTurns(): SidecarTurn[] {
    return this.current ? [...this.turns, this.current] : [...this.turns];
  }

  takeWarning(): string {
    const warning = this.lastWarning;
    this.lastWarning = '';
    return warning;
  }

  /** 收到一条通知。返回 true 表示有可见变化（等待类工具据此提前返回）。 */
  apply(notification: Notification): boolean {
    const changed = this.applyNotification(notification);
    if (changed) this.revision += 1;
    return changed;
  }

  private applyNotification(notification: Notification): boolean {
    const method = asString(notification.method);
    const params = notification.params ?? {};
    switch (method) {
      case 'turn/started': {
        const turn = asRecord(params.turn);
        const id = asString(turn?.id) || `turn-${Date.now()}`;
        this.finishCurrent('interrupted', '新一轮开始时上一轮还没结束');
        this.startTurn(id);
        return true;
      }
      case 'item/agentMessage/delta': {
        if (!this.ensureTurn()) return false;
        return this.appendBody('text', asString(params.delta));
      }
      case 'item/reasoning/textDelta': {
        if (!this.ensureTurn()) return false;
        return this.appendBody('thinking', asString(params.delta));
      }
      case 'item/started': {
        const item = asRecord(params.item);
        if (!item || !this.ensureTurn()) return false;
        if (item.type !== 'commandExecution') return false;
        const id = asString(item.id) || `tool-${Date.now()}`;
        const title = asString(item.displayText) || asString(item.command) || 'tool';
        this.current!.tools.push({ id, title, status: 'running' });
        trimTools(this.current!.tools);
        return true;
      }
      case 'item/commandExecution/outputDelta': {
        if (!this.ensureTurn()) return false;
        const tool = this.findTool(asString(params.itemId));
        if (!tool) return false;
        // 已经截断的输出不再拼接：一条刷屏的命令每秒几十个 delta，而尾巴注定要丢。
        if ((tool.output ?? '').length >= MAX_TOOL_OUTPUT) return false;
        tool.output = clamp(`${tool.output ?? ''}${asString(params.delta)}`, MAX_TOOL_OUTPUT);
        return true;
      }
      case 'item/completed': {
        const item = asRecord(params.item);
        if (!item || !this.ensureTurn()) return false;
        if (item.type === 'agentMessage') {
          // completed 带的是这一条消息的全文：比 delta 拼接更可靠（断线补发、
          // 多段消息都不会错位），所以以它为准。
          const text = asString(item.text);
          if (text) this.setBody('text', text);
          return true;
        }
        if (item.type === 'reasoning') {
          const content = Array.isArray(item.content) ? item.content.filter((part) => typeof part === 'string') : [];
          if (content.length) this.setBody('thinking', content.join('\n'));
          return true;
        }
        if (item.type === 'commandExecution') {
          const tool = this.findTool(asString(item.id));
          if (!tool) return false;
          const status = asString(item.status);
          tool.status = status === 'error' || status === 'failed' ? 'error' : 'completed';
          const output = asString(item.aggregatedOutput);
          if (output) tool.output = clamp(output, MAX_TOOL_OUTPUT);
          return true;
        }
        return false;
      }
      case 'turn/completed': {
        const turn = asRecord(params.turn);
        const status = asString(turn?.status);
        const error = asRecord(turn?.error);
        this.finishCurrent(
          status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed',
          asString(error?.message) || undefined,
        );
        return true;
      }
      // 宿主取走排队消息（`turn/steer` / after_iteration 注入）时发。这是唯一能分辨
      // 「这句话进了当前轮还是下一轮」的信号：此刻还在跑就是当前轮，否则等下一轮 start。
      case 'mica/queue/dequeue': {
        const queued = asRecord(params.input);
        if (!queued) return false;
        return this.claimQueuedInput(asString(queued.text));
      }
      case 'thread/tokenUsage/updated': {
        const usage = asRecord(params.tokenUsage);
        const total = asRecord(usage?.total);
        const last = asRecord(usage?.last);
        this.usage = {
          input: asNumber(total?.input_tokens),
          output: asNumber(total?.output_tokens),
          total: asNumber(total?.total_tokens),
          contextTokens: asNumber(last?.input_tokens) + asNumber(last?.cached_input_tokens),
        };
        return true;
      }
      case 'warning': {
        const warning = asRecord(params.warning);
        const message = asString(warning?.message);
        if (message) this.lastWarning = message;
        return false;
      }
      case 'error': {
        const error = asRecord(params.error);
        const message = asString(error?.message);
        if (message) this.lastWarning = message;
        return true;
      }
      default:
        return false;
    }
  }

  /** 进程退出/被中断时把还在跑的那一轮收尾，别让它永远显示 running。 */
  abort(status: SidecarTurnStatus = 'interrupted', reason?: string): void {
    this.finishCurrent(status, reason);
  }

  private ensureTurn(): boolean {
    if (this.current) return true;
    // 有些通知（尤其是错误）可能先于 turn/started 到达；补一条占位轮次，
    // 否则这段输出会落在一个不存在的地方、界面上什么都看不到。
    this.startTurn(`turn-${Date.now()}`);
    return true;
  }

  private startTurn(id: string): void {
    this.current = {
      id,
      status: 'running',
      text: '',
      thinking: '',
      tools: [],
      userInputs: this.takePendingInputs(),
      startedAt: Date.now(),
    };
    this.textOverflow = false;
    this.thinkingOverflow = false;
  }

  /**
   * 追加一段 delta。返回 false 表示没有可见变化（已到上限、或 delta 为空），
   * 等待类工具据此不再因为一条注定被丢弃的尾巴醒一次。
   */
  private appendBody(field: 'text' | 'thinking', delta: string): boolean {
    const turn = this.current;
    if (!turn || !delta) return false;
    if (field === 'text' ? this.textOverflow : this.thinkingOverflow) return false;
    const next = turn[field] + delta;
    if (next.length <= MAX_TEXT) {
      turn[field] = next;
      return true;
    }
    turn[field] = clamp(next, MAX_TEXT);
    if (field === 'text') this.textOverflow = true;
    else this.thinkingOverflow = true;
    return true;
  }

  /** 用完整正文覆盖（`item/completed` 带的是权威全文），并重算是否已经到上限。 */
  private setBody(field: 'text' | 'thinking', value: string): void {
    const turn = this.current;
    if (!turn) return;
    turn[field] = clamp(value, MAX_TEXT);
    const overflow = value.length > MAX_TEXT;
    if (field === 'text') this.textOverflow = overflow;
    else this.thinkingOverflow = overflow;
  }

  private findTool(id: string): SidecarToolCall | null {
    if (!id) return null;
    return this.current?.tools.find((tool) => tool.id === id) ?? null;
  }

  private finishCurrent(status: SidecarTurnStatus, error?: string): void {
    if (!this.current) return;
    const turn = this.current;
    // 还在跑的工具不能留在 running：这一轮已经结束了。但也不能一律记成 completed——
    // 被打断的 `sleep 60` 显示「已完成」会让读的人以为它真的跑完了。
    const unfinished = status === 'completed' ? 'completed' : status === 'failed' ? 'error' : 'interrupted';
    for (const tool of turn.tools) {
      if (tool.status === 'running') tool.status = unfinished;
    }
    turn.status = status;
    if (error) turn.error = error;
    turn.finishedAt = Date.now();
    this.turns.push(turn);
    if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS);
    this.finishedTurns += 1;
    this.current = null;
    this.textOverflow = false;
    this.thinkingOverflow = false;
  }
}
