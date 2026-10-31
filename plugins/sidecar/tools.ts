import { MicaTool, type ToolExecuteCallbacks } from '@packages/mica-tools/MicaTool.js';
import { MAX_SIDECARS, waitBaseline, waitSatisfied, type SidecarRegistry } from './registry.js';
import {
  DEFAULT_TURN_INDEX_LIMIT,
  DEFAULT_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  clip,
  grepTranscript,
  renderSidecar,
  renderTranscript,
  renderTurnIndex,
} from './views.js';

/**
 * 子会话的工具：开一个、说一句、看进度、定位轮次、搜对话、读对话、等它、打断、收掉。
 *
 * 它们都是「父会话对另一个 mica 会话的操作」，所以只有主 agent 能用——子代理（Agent
 * 工具起的 subagent）不该再派生会话，那会变成没人收的进程树。
 *
 * 读的三件（`sidecar_turns` / `sidecar_grep` / `sidecar_transcript`）成本差一个数量级，
 * 顺序也是这么排的：先定位到哪一轮、再确认那句话在哪、最后才读正文。
 */

const EXECUTE_NOTE = '子会话是一个独立的 mica 会话（自己的上下文、自己的进程），它的对话会落进会话列表。';

const DEFAULT_WAIT_TIMEOUT_MS = 180_000;

function parseTimeout(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(number, 900_000);
}

export class SidecarSpawnTool extends MicaTool {
  constructor(private readonly registry: SidecarRegistry) {
    super(
      'sidecar_spawn',
      '开一个子会话（独立的 mica 会话）并让它开始干活，返回会话 id。' +
        '适合把一段能独立完成、又不该占满当前上下文的工作交出去：跑一组测试、查一份资料、改一个独立模块。' +
        '子会话会出现在会话列表里（挂在当前会话下面），用户可以自己点开看。' +
        EXECUTE_NOTE +
        '开完先用 sidecar_wait 等结果，不要立刻连续 send。',
      {
        type: 'object' as const,
        properties: {
          prompt: { type: 'string', description: '交给子会话的第一句话：目标、边界、验证方式都要写清楚。' },
          title: {
            type: 'string',
            description: '给这条子会话起个便于在 sidecar_status 里辨认的标签；缺省取 prompt 第一行。',
          },
          cwd: { type: 'string', description: '子会话的工作目录，默认与当前会话相同。' },
          role: { type: 'string', description: '角色名（$MICA_HOME/role/<name>.md），默认沿用当前配置。' },
          model: { type: 'string', description: '模型 id（provider/model），默认沿用当前配置。' },
          effort: { type: 'string', description: '推理档位，取该模型声明的档位名。' },
          max_turns: { type: 'integer', minimum: 1, description: '最多几轮模型往返，用来兜住跑飞的任务。' },
        },
        required: ['prompt'],
      },
    );
  }

  async execute(
    input: {
      prompt: string;
      title?: string;
      cwd?: string;
      role?: string;
      model?: string;
      effort?: string;
      max_turns?: number;
    },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const result = await this.registry.spawn({
      prompt: String(input.prompt ?? ''),
      ...(input.title ? { title: input.title } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.max_turns !== undefined ? { maxTurns: input.max_turns } : {}),
      ...(callbacks?.signal ? { signal: callbacks.signal } : {}),
    });
    if (!result.ok) return result.error;
    const { entry } = result;
    return [
      `子会话已启动：${entry.id}`,
      `标题：${entry.title}`,
      `目录：${entry.cwd}`,
      '',
      '第一句话已经投出去了，它正在跑。接下来：',
      '· `sidecar_wait` 等它这一轮结束（推荐，别用 sleep 忙等）',
      '· `sidecar_status` 看它现在说到哪了、调了哪些工具',
      `· 最多同时 ${MAX_SIDECARS} 个子会话；跑完用 \`sidecar_close\` 收掉进程`,
      '',
      '注意：会话文件要等它这一轮结束才会落盘，在那之前侧栏还看不到它。',
    ].join('\n');
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `sidecar spawn ${clip(String(input.title ?? input.prompt ?? ''), 40)}`;
  }
}

export class SidecarSendTool extends MicaTool {
  constructor(private readonly registry: SidecarRegistry) {
    super(
      'sidecar_send',
      '给一个还在跑的子会话追加一句话。' +
        '这一轮正在跑时消息会排到它的下一个迭代边界（与用户按回车一致），不会打断它；空闲时直接开新一轮。' +
        '不要用它轮询进度——看进度用 sidecar_status，等结果用 sidecar_wait。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'sidecar_spawn 返回的会话 id（可只给唯一前缀）。' },
          text: { type: 'string', description: '要追加的话。' },
        },
        required: ['session_id', 'text'],
      },
    );
  }

  async execute(input: { session_id: string; text: string }): Promise<string> {
    const entry = this.registry.get(String(input.session_id ?? ''));
    if (!entry) return `找不到子会话：${input.session_id}。用 sidecar_status 列出当前有哪些。`;
    const text = String(input.text ?? '').trim();
    if (!text) return '消息内容为空。';
    try {
      const { queued } = await entry.process.send(text);
      return queued ? `已排进 ${entry.id} 的当前这一轮（下一迭代边界注入）。` : `已发送，${entry.id} 开始新的一轮。`;
    } catch (error) {
      return `发送失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `sidecar send ${clip(String(input.session_id ?? ''), 10)}`;
  }
}

export class SidecarStatusTool extends MicaTool {
  constructor(private readonly registry: SidecarRegistry) {
    super(
      'sidecar_status',
      '查看子会话的进度：在不在跑、这一轮说到哪、调了哪些工具、上一轮结论。' +
        '不传 session_id 时列出全部子会话（每个只给一行摘要）。只读，运行中随时可看。' +
        '自上次查看后没有新输出时只回一行状态，所以反复查不会把上下文撑大。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀；省略则列出全部。' },
          full: {
            type: 'boolean',
            description: 'true 时带更长的正文、工具输出、思考节选与更早几轮（投影会明显变长）。',
          },
        },
      },
      { readOnly: true },
    );
  }

  async execute(input: { session_id?: string; full?: boolean }): Promise<string> {
    this.registry.sweep();
    if (input.session_id) {
      const entry = this.registry.get(String(input.session_id));
      if (!entry) return `找不到子会话：${input.session_id}`;
      // 查进度是高频动作：转录没变时只回一行，别让每次 poll 都重投一份全文。
      return renderSidecar(entry, { full: input.full === true, quietWhenUnchanged: true });
    }
    const entries = this.registry.list();
    if (!entries.length) {
      return '当前没有子会话。需要时用 sidecar_spawn 开一个。';
    }
    const lines = entries.map((entry) => {
      const transcript = entry.process.transcript;
      const latest = transcript.latestTurn;
      const state = entry.process.closed ? '已退出' : transcript.busy ? '运行中' : '空闲';
      const head = `${entry.id} · ${state} · ${transcript.totalTurnCount} 轮 · ${clip(entry.title, 40)}`;
      const tail = latest ? clip((latest.text || '').replace(/\s+/g, ' '), 160) : '（还没有内容）';
      return `${head}\n  ${tail}`;
    });
    if (entries.some((entry) => entry.process.closed)) {
      // 死会话留着是为了能读最后一轮（见 registry 的 MAX_DEAD_ENTRIES），得让模型
      // 知道别一直拿它当「空闲」，也别忘了收。
      lines.push('（已退出的会话仍能读最后一轮；不再需要时用 sidecar_close 清掉）');
    }
    return lines.join('\n');
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return input.session_id ? `sidecar status ${clip(String(input.session_id), 10)}` : 'sidecar list';
  }
}

export class SidecarTurnsTool extends MicaTool {
  constructor(private readonly registry: SidecarRegistry) {
    super(
      'sidecar_turns',
      '列出子会话的轮次索引：每轮一行（时间、终态、耗时、问答各一句摘要）。' +
        '想知道「它一共跑了几轮、第几轮在做什么」时先用这个，比直接读对话便宜一个数量级；' +
        '找到目标轮次后再用 sidecar_grep 或 sidecar_transcript 取内容。只读。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀。' },
          limit: {
            type: 'number',
            description: `列最近几轮，默认 ${DEFAULT_TURN_INDEX_LIMIT}，最多 20。`,
          },
        },
        required: ['session_id'],
      },
      { readOnly: true },
    );
  }

  async execute(input: { session_id: string; limit?: number }): Promise<string> {
    this.registry.sweep();
    const entry = this.registry.get(String(input.session_id ?? ''));
    if (!entry) return `找不到子会话：${input.session_id}。用 sidecar_status 列出当前有哪些。`;
    return renderTurnIndex(entry, input.limit ? { limit: Number(input.limit) } : {});
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `sidecar turns ${clip(String(input.session_id ?? ''), 10)}`;
  }
}

export class SidecarGrepTool extends MicaTool {
  constructor(private readonly registry: SidecarRegistry) {
    super(
      'sidecar_grep',
      '在子会话的对话里搜关键词，只回命中所在的那些行（带轮次与说话人）。' +
        '想知道「它在哪说过这个报错 / 有没有提到这个文件」时用它，不要为此读整段对话。' +
        '搜的是对话正文（用户 + 助手），不含工具输出——工具行在 sidecar_status 里。只读。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀。' },
          pattern: { type: 'string', description: '正则（区分大小写）。搜普通文本时注意转义 . * ( ) 之类。' },
          max_matches: { type: 'number', description: '最多列出几处，默认 8，最多 30。' },
        },
        required: ['session_id', 'pattern'],
      },
      { readOnly: true },
    );
  }

  async execute(input: { session_id: string; pattern: string; max_matches?: number }): Promise<string> {
    this.registry.sweep();
    const entry = this.registry.get(String(input.session_id ?? ''));
    if (!entry) return `找不到子会话：${input.session_id}`;
    if (!input.pattern) return 'pattern 不能为空。';
    let pattern: RegExp;
    try {
      pattern = new RegExp(String(input.pattern));
    } catch (error) {
      return `pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}`;
    }
    return grepTranscript(entry, {
      pattern,
      ...(input.max_matches ? { maxMatches: Number(input.max_matches) } : {}),
    });
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `sidecar grep ${clip(String(input.pattern ?? ''), 30)}`;
  }
}

export class SidecarTranscriptTool extends MicaTool {
  constructor(private readonly registry: SidecarRegistry) {
    super(
      'sidecar_transcript',
      '读取子会话的对话正文：用户说了什么、助手回了什么，**不含工具调用与思考**。' +
        `按字符预算截断（默认 ${DEFAULT_TRANSCRIPT_CHARS} 字符 ≈ 4k token，上限 ${MAX_TRANSCRIPT_CHARS}），` +
        '超预算时丢最早的那几轮并说明丢了几轮。默认只读最近 1 轮——要更多就显式传 last_turns 与 max_chars。' +
        '想找某一句话先用 sidecar_grep，想定位轮次先用 sidecar_turns。只读。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀。' },
          last_turns: { type: 'number', description: '读最近几轮，默认 1，最多 20。' },
          include_user: {
            type: 'boolean',
            description: '是否带上投进去的用户消息，默认 true。只看它的输出时传 false。',
          },
          max_chars: {
            type: 'number',
            description: `这次输出的总字符预算，默认 ${DEFAULT_TRANSCRIPT_CHARS}，上限 ${MAX_TRANSCRIPT_CHARS}。`,
          },
        },
        required: ['session_id'],
      },
      { readOnly: true },
    );
  }

  async execute(input: {
    session_id: string;
    last_turns?: number;
    include_user?: boolean;
    max_chars?: number;
  }): Promise<string> {
    this.registry.sweep();
    const entry = this.registry.get(String(input.session_id ?? ''));
    if (!entry) return `找不到子会话：${input.session_id}`;
    return renderTranscript(entry, {
      ...(input.last_turns ? { lastTurns: Number(input.last_turns) } : {}),
      ...(input.include_user === false ? { includeUser: false } : {}),
      ...(input.max_chars ? { maxChars: Number(input.max_chars) } : {}),
    });
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `sidecar transcript ${clip(String(input.session_id ?? ''), 10)}`;
  }
}

export class SidecarWaitTool extends MicaTool {
  constructor(private readonly registry: SidecarRegistry) {
    super(
      'sidecar_wait',
      '等子会话满足一个条件，然后返回它的状态。默认等「这一轮跑完」。' +
        '这是阻塞等待（可以与同一条消息里的其它工具并行），不要在它后面再补 sleep。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀。' },
          until: {
            type: 'string',
            enum: ['idle', 'text', 'turn'],
            description:
              'idle = 等当前与排队消息全部结束；text = 在最近一轮完整正文匹配 pattern（已出现也算）；turn = 等至少一轮在调用后结束，包含当前正在运行的轮次。默认 idle。',
          },
          pattern: { type: 'string', description: 'until=text 时的正则（区分大小写），在最近一轮正文里匹配。' },
          timeout_ms: { type: 'number', description: `等待上限，默认 ${DEFAULT_WAIT_TIMEOUT_MS}ms，最大 900000。` },
        },
        required: ['session_id'],
      },
      { overlappable: true },
    );
  }

  async execute(
    input: { session_id: string; until?: string; pattern?: string; timeout_ms?: number },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    if (input.until !== undefined && input.until !== 'idle' && input.until !== 'text' && input.until !== 'turn') {
      return 'until 必须为 idle、text 或 turn。';
    }
    if (input.timeout_ms !== undefined && (!Number.isFinite(input.timeout_ms) || input.timeout_ms <= 0)) {
      return 'timeout_ms 必须为正数。';
    }
    const entry = this.registry.get(String(input.session_id ?? ''));
    if (!entry) return `找不到子会话：${input.session_id}`;
    const until = input.until === 'text' || input.until === 'turn' ? input.until : 'idle';
    let pattern: RegExp | null = null;
    if (until === 'text') {
      if (!input.pattern) return 'until=text 需要提供 pattern。';
      try {
        pattern = new RegExp(String(input.pattern));
      } catch (error) {
        return `pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const transcript = entry.process.transcript;
    const baseline = waitBaseline(transcript);
    const deadline = Date.now() + parseTimeout(input.timeout_ms);

    while (true) {
      if (callbacks?.signal?.aborted) return `已取消等待（${entry.id} 仍在跑）。`;
      if (entry.process.closed) {
        return `子会话进程已退出。\n\n${renderSidecar(entry)}`;
      }
      const verdict = waitSatisfied(transcript, until, pattern, baseline);
      if (verdict.done) {
        // 条件成立时一定要给全量投影：模型等的就是这份结果。
        return `${verdict.detail ?? '条件成立'}\n\n${renderSidecar(entry)}`;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // 超时往往紧接着又一次超时，这段文字会重复进上下文；没新输出时就只回状态行。
        return `等待超时（${parseTimeout(input.timeout_ms)}ms）。它可能还在跑，用 sidecar_status 继续看。\n\n${renderSidecar(entry, { quietWhenUnchanged: true })}`;
      }
      // 有变化就重新判断，没变化就等到下一次通知或 500ms 兜底——不忙轮询。
      await entry.process.waitForChange(Math.min(remaining, 500), callbacks?.signal);
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `sidecar wait ${clip(String(input.session_id ?? ''), 10)} · ${String(input.until ?? 'idle')}`;
  }
}

export class SidecarAbortTool extends MicaTool {
  constructor(private readonly registry: SidecarRegistry) {
    super(
      'sidecar_abort',
      '打断子会话当前这一轮（进程与会话都还在，之后还能继续 sidecar_send）。' +
        '跑飞了或者已经不需要这个结果时用它，比直接 close 更能保住已经跑出来的内容。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀。' },
        },
        required: ['session_id'],
      },
    );
  }

  async execute(input: { session_id: string }): Promise<string> {
    const entry = this.registry.get(String(input.session_id ?? ''));
    if (!entry) return `找不到子会话：${input.session_id}`;
    try {
      const stopped = await entry.process.abort();
      return stopped ? `已打断 ${entry.id} 当前这一轮。` : `${entry.id} 当前没有在跑的一轮。`;
    } catch (error) {
      return `打断失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `sidecar abort ${clip(String(input.session_id ?? ''), 10)}`;
  }
}

export class SidecarCloseTool extends MicaTool {
  constructor(private readonly registry: SidecarRegistry) {
    super(
      'sidecar_close',
      '收掉子会话的进程。会话本身留在会话列表里（历史不丢），只是不再占着进程与并发名额。' +
        '已经拿到需要的结论就关掉它，别让一堆跑完的子会话一直挂着。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀。' },
        },
        required: ['session_id'],
      },
    );
  }

  async execute(input: { session_id: string }): Promise<string> {
    const entry = this.registry.get(String(input.session_id ?? ''));
    if (!entry) return `找不到子会话：${input.session_id}`;
    const id = entry.id;
    await this.registry.close(id);
    return `已关闭 ${id}。会话历史仍在会话列表里，随时可以重新打开。`;
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `sidecar close ${clip(String(input.session_id ?? ''), 10)}`;
  }
}
