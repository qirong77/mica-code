import { MicaTool, type ToolExecuteCallbacks } from '@packages/mica-tools/MicaTool.js';
import { waitBaseline, waitSatisfied, type SubagentEntry, type SubagentRegistry } from './registry.js';
import {
  DEFAULT_TURN_INDEX_LIMIT,
  DEFAULT_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  clip,
  grepTranscript,
  renderCollect,
  renderSubagent,
  renderTranscript,
  renderTurnIndex,
  sinceLabel,
} from './views.js';

/**
 * 子会话的工具：六个动词，一个主语。
 *
 * 主语是「一条被驱动的 mica 会话」（`session_id`，可只给唯一前缀），动词按意图分：
 *
 * - `subagent_open`  开一条：新建（投第一件事）或接管已落盘的；
 * - `subagent_send`  投一句话；
 * - `subagent_wait`  等条件成立；
 * - `subagent_status` 看状态：一条 / 全部一行 / 全部带结论；
 * - `subagent_read`  读内容：轮次索引 → 命中行 → 正文，三档成本用 `view` 选；
 * - `subagent_stop`  停：打断这一轮，或收掉进程。
 *
 * 刻意不按实现分层拆工具（spawn / attach / turns / grep / transcript / abort / close 各来一个）：
 * 那会把「同一件事的不同力度」摊成模型每次都要重新挑的一排名字，工具 schema 本身也进
 * 每次请求的前缀。动作之间的取舍写在描述里，比多一个工具名更省。
 *
 * 它们都是「父会话对另一个 mica 会话的操作」，只有主 agent 能用——子代理（`agent` 工具起的
 * 子代理）不该再派生会话，那会变成没人收的进程树。
 */

const EXECUTE_NOTE = '子会话是一个独立的 mica 会话（自己的上下文、自己的进程），它的对话会落进会话列表。';

const DEFAULT_WAIT_TIMEOUT_MS = 180_000;

function parseTimeout(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(number, 900_000);
}

/**
 * 把一句话交给一条已经拿到的会话：跑着就排到下一迭代边界，空闲就开新一轮。
 *
 * `open`（接管后直接派活）与 `send` 共用这一处——两边的投递语义、排队提示与「进程已经退了
 * 就提示先接回来」的处理必须一模一样。
 */
async function deliver(entry: SubagentEntry, text: string): Promise<string> {
  const content = text.trim();
  if (!content) return '消息内容为空。';
  try {
    const { queued } = await entry.process.send(content);
    return queued ? `已排进 ${entry.id} 的当前这一轮（下一迭代边界注入）。` : `已发送，${entry.id} 开始新的一轮。`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 进程已经不在了：会话本身还在磁盘上，接回来接着干，别让上下文白丢。
    if (entry.process.closed) {
      return (
        `${entry.id} 的进程已经退出（${message}）。\n` +
        `先 \`subagent_open({ session_id: "${entry.id}" })\` 接回这条会话，再 subagent_send 就接着干。`
      );
    }
    return `发送失败：${message}`;
  }
}

export class SubagentOpenTool extends MicaTool {
  constructor(private readonly registry: SubagentRegistry) {
    super(
      'subagent_open',
      '开一条要驱动的 mica 会话，返回会话 id。两种用法：' +
        '**不给 session_id** = 新建一条并投第一件事——适合把一段能独立完成、又不该占满当前上下文的工作交出去' +
        '（跑一组测试、查一份资料、改一个独立模块）；它出现在会话列表里（挂在当前会话下面），用户可以自己点开看。' +
        '**给 session_id** = 接管一条已经落盘的会话（用户别的会话、别处收掉的子会话、重启前留下的），' +
        '历史从会话文件补进来（工具调用只有名字），不新建、不产生空壳；同时给 prompt 就接着派一句话。' +
        EXECUTE_NOTE +
        '开完先用 subagent_wait 等结果，不要立刻连续 send。',
      {
        type: 'object' as const,
        properties: {
          prompt: {
            type: 'string',
            description:
              '交给它的话：目标、边界、验证方式都要写清楚。新建时必填（就是第一件事）；接管时可省（只接管不派活）。',
          },
          session_id: {
            type: 'string',
            description: '要接管的会话 id（完整 id，会话列表里那条）。省略则新建；接管不到当前会话自己。',
          },
          title: {
            type: 'string',
            description: '便于在 subagent_status 里辨认的标签；新建时缺省取 prompt 第一行，接管时缺省取会话标题。',
          },
          cwd: { type: 'string', description: '工作目录，新建时默认与当前会话相同，接管时默认用它自己的。' },
          role: {
            type: 'string',
            description:
              '角色名（$MICA_HOME/role/<name>.md），默认沿用父会话的角色；不确定就省略，别填「当前角色」这类描述。接管时忽略。',
          },
          model: {
            type: 'string',
            description: '模型 id（provider/model），默认沿用父会话；不确定就省略，别猜模型名（猜错第一轮就 400）。接管时忽略。',
          },
          effort: { type: 'string', description: '推理档位，取该模型声明的档位名；不确定就省略。接管时忽略。' },
        },
      },
    );
  }

  async execute(
    input: {
      prompt?: string;
      session_id?: string;
      title?: string;
      cwd?: string;
      role?: string;
      model?: string;
      effort?: string;
    },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const sessionId = String(input.session_id ?? '').trim();
    const prompt = String(input.prompt ?? '');
    if (sessionId) return this.attach(sessionId, input, prompt, callbacks);
    if (!prompt.trim()) {
      return '要么给 prompt 新建一条子会话，要么给 session_id 接管一条已有的：两个都没给，看不出要开哪条。';
    }
    const result = await this.registry.spawn({
      prompt,
      ...(input.title ? { title: input.title } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
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
      '· `subagent_wait` 等它这一轮结束（推荐，别用 sleep 忙等）',
      '· `subagent_status` 看它现在说到哪了、调了哪些工具',
      '· 跑完用 `subagent_stop({ action: "close" })` 收掉进程（不收也会一直待着，像正常会话一样）',
      '',
      '它每一轮结束、卡住、进程退出都会记成一条动态，你下一轮开工时自动看到——不必反复轮询。',
      '注意：会话文件要等它这一轮结束才会落盘，在那之前侧栏还看不到它。',
    ].join('\n');
  }

  private async attach(
    sessionId: string,
    input: { cwd?: string; title?: string },
    prompt: string,
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const result = await this.registry.attach({
      sessionId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(callbacks?.signal ? { signal: callbacks.signal } : {}),
    });
    if (!result.ok) return result.error;
    const { entry } = result;
    const header = [`已接管会话：${entry.id}`, `标题：${entry.title}`, `目录：${entry.cwd}`];
    if (prompt.trim()) {
      return [...header, '', await deliver(entry, prompt)].join('\n');
    }
    return [
      ...header,
      '',
      '它现在空闲，接着干的下一步：',
      '· `subagent_send` 交给它下一句',
      '· `subagent_read({ view: "turns" })` 看它之前做到哪了（历史来自会话文件）',
    ].join('\n');
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    if (input.session_id) return `subagent open 接管 ${clip(String(input.session_id), 10)}`;
    return `subagent open ${clip(String(input.title ?? input.prompt ?? ''), 40)}`;
  }
}

export class SubagentSendTool extends MicaTool {
  constructor(private readonly registry: SubagentRegistry) {
    super(
      'subagent_send',
      '给一条已经在驱动的子会话追加一句话。' +
        '这一轮正在跑时消息会排到它的下一个迭代边界（与用户按回车一致），不会打断它；空闲时直接开新一轮。' +
        '不要用它轮询进度——看进度用 subagent_status，等结果用 subagent_wait。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'subagent_open 返回的会话 id（可只给唯一前缀）。' },
          text: { type: 'string', description: '要追加的话。' },
        },
        required: ['session_id', 'text'],
      },
    );
  }

  async execute(input: { session_id: string; text: string }): Promise<string> {
    const entry = this.registry.get(String(input.session_id ?? ''));
    if (!entry) return `找不到子会话：${input.session_id}。用 subagent_status 列出当前有哪些。`;
    // 这里不设任何前置拦阻：能投就投。会话文件还在，进程退出了也能 open 接回来。
    return deliver(entry, String(input.text ?? ''));
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `subagent send ${clip(String(input.session_id ?? ''), 10)}`;
  }
}

export class SubagentStatusTool extends MicaTool {
  constructor(private readonly registry: SubagentRegistry) {
    super(
      'subagent_status',
      '看子会话的状态：在不在跑、这一轮说到哪、调了哪些工具、上一轮结论。' +
        '给 session_id 看这一条；不给就列出全部（每条一行摘要）；`full: true` 换成收尾视图——' +
        '每条的状态、轮数、最后一轮结论、失败的工具与用量，一屏替代 wait×N + read×N。' +
        '只读，运行中随时可看；自上次查看后没有新输出时只回一行，反复查不会把上下文撑大。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀；省略则看全部。' },
          session_ids: { type: 'array', items: { type: 'string' }, description: '只看这几条（收尾视图）。' },
          full: {
            type: 'boolean',
            description:
              'true 时给收尾视图：每条的状态、轮数、结论、失败工具、用量（不带 session_id 时）；带 session_id 时给更长的正文、工具输出、思考节选与更早几轮。',
          },
        },
      },
      { readOnly: true },
    );
  }

  async execute(input: { session_id?: string; session_ids?: string[]; full?: boolean }): Promise<string> {
    this.registry.sweep();
    if (input.session_id) {
      const entry = this.registry.get(String(input.session_id));
      if (!entry) return `找不到子会话：${input.session_id}`;
      this.registry.markRead(entry.id);
      // 查进度是高频动作：转录没变时只回一行，别让每次 poll 都重投一份全文。
      return renderSubagent(entry, { full: input.full === true, quietWhenUnchanged: true });
    }
    const ids = (input.session_ids ?? []).map(String);
    if (ids.length || input.full === true) return this.collect(ids);
    const entries = this.registry.list();
    if (!entries.length) {
      return '当前没有子会话。需要时用 subagent_open 开一个。';
    }
    const lines = entries.map((entry) => {
      const transcript = entry.process.transcript;
      const latest = transcript.latestTurn;
      const state = entry.process.closed ? '已退出' : transcript.busy ? '运行中' : '空闲';
      // 「最近动静」是这一行里唯一能区分「在跑」和「卡住」的信息。
      const head =
        `${entry.id} · ${state} · ${transcript.totalTurnCount} 轮 · 最近动静 ${sinceLabel(transcript.lastActivityAt)}` +
        ` · ${clip(entry.title, 40)}`;
      const tail = latest ? clip((latest.text || '').replace(/\s+/g, ' '), 160) : '（还没有内容）';
      return `${head}\n  ${tail}`;
    });
    if (entries.some((entry) => entry.process.closed)) {
      // 死会话留着是为了能读最后一轮（见 registry 的 MAX_DEAD_ENTRIES），得让模型
      // 知道别一直拿它当「空闲」，也别忘了收。
      lines.push('（已退出的会话仍能读最后一轮；不再需要时用 subagent_stop({ action: "close" }) 清掉）');
    }
    return lines.join('\n');
  }

  /** 收尾视图：一屏给出每条会话的终态、结论、失败工具与用量。 */
  private collect(ids: string[]): string {
    const entries = ids.length
      ? ids.map((id) => this.registry.get(id)).filter((entry): entry is SubagentEntry => Boolean(entry))
      : this.registry.list();
    if (ids.length && entries.length !== ids.length) {
      const found = new Set(entries.map((entry) => entry.id));
      const missing = ids.filter((id) => !found.has(id) && !this.registry.get(id));
      if (missing.length) return `找不到子会话：${missing.join('、')}`;
    }
    for (const entry of entries) this.registry.markRead(entry.id);
    const report = renderCollect(entries);
    if (!entries.some((entry) => !entry.process.closed && !entry.process.transcript.busy)) return report;
    return `${report}\n\n不再需要的用 subagent_stop({ action: "close", idle: true }) 收掉跑完的（历史与会话仍在，可 open 接回）。`;
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    if (input.session_id) return `subagent status ${clip(String(input.session_id), 10)}`;
    if (input.full === true || Array.isArray(input.session_ids)) return 'subagent status 收尾';
    return 'subagent list';
  }
}

export class SubagentReadTool extends MicaTool {
  constructor(private readonly registry: SubagentRegistry) {
    super(
      'subagent_read',
      '读子会话的对话。`view` 是按成本从低到高的三档，不要跳级：' +
        `turns = 轮次索引（每轮一行：时间、终态、耗时、问答各一句摘要），先定位第几轮；` +
        'grep = 只回命中行（带轮次与说话人），确认那句话在哪；' +
        `transcript = 正文（用户 + 助手，不含工具与思考），按字符预算截断（默认 ${DEFAULT_TRANSCRIPT_CHARS}，上限 ${MAX_TRANSCRIPT_CHARS}），默认只读最近 1 轮。` +
        '只读。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀。' },
          view: {
            type: 'string',
            enum: ['turns', 'grep', 'transcript'],
            description: 'turns = 轮次索引；grep = 命中行；transcript = 正文。',
          },
          limit: { type: 'number', description: `view=turns：列最近几轮，默认 ${DEFAULT_TURN_INDEX_LIMIT}，最多 20。` },
          pattern: { type: 'string', description: 'view=grep：正则（区分大小写）。搜普通文本时注意转义 . * ( ) 之类。' },
          max_matches: { type: 'number', description: 'view=grep：最多列出几处，默认 8，最多 30。' },
          scope: {
            type: 'string',
            enum: ['text', 'tools', 'all'],
            description: 'view=grep：text = 只搜对话正文（默认），tools = 只搜命令输出与测试报错，all = 两边都搜。',
          },
          last_turns: { type: 'number', description: 'view=transcript：读最近几轮，默认 1，最多 20。' },
          include_user: {
            type: 'boolean',
            description: 'view=transcript：是否带上投进去的用户消息，默认 true。只看它的输出时传 false。',
          },
          max_chars: {
            type: 'number',
            description: `view=transcript：这次输出的总字符预算，默认 ${DEFAULT_TRANSCRIPT_CHARS}，上限 ${MAX_TRANSCRIPT_CHARS}。`,
          },
        },
        required: ['session_id', 'view'],
      },
      { readOnly: true },
    );
  }

  async execute(input: {
    session_id: string;
    view: string;
    limit?: number;
    pattern?: string;
    max_matches?: number;
    scope?: 'text' | 'tools' | 'all';
    last_turns?: number;
    include_user?: boolean;
    max_chars?: number;
  }): Promise<string> {
    const view = String(input.view ?? '').trim();
    // 参数问题先答，别让模型以为「找不到会话」是它没选对视图。
    if (view !== 'turns' && view !== 'grep' && view !== 'transcript') return 'view 必须为 turns、grep 或 transcript。';
    let pattern: RegExp | null = null;
    if (view === 'grep') {
      if (!input.pattern) return 'view=grep 需要提供 pattern。';
      try {
        pattern = new RegExp(String(input.pattern));
      } catch (error) {
        return `pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.registry.sweep();
    const entry = this.registry.get(String(input.session_id ?? ''));
    if (!entry) return `找不到子会话：${input.session_id}。用 subagent_status 列出当前有哪些。`;
    if (view === 'turns') {
      this.registry.markRead(entry.id);
      return renderTurnIndex(entry, input.limit ? { limit: Number(input.limit) } : {});
    }
    if (view === 'grep') {
      this.registry.markRead(entry.id);
      return grepTranscript(entry, {
        pattern: pattern!,
        ...(input.max_matches ? { maxMatches: Number(input.max_matches) } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
      });
    }
    this.registry.markRead(entry.id);
    return renderTranscript(entry, {
      ...(input.last_turns ? { lastTurns: Number(input.last_turns) } : {}),
      ...(input.include_user === false ? { includeUser: false } : {}),
      ...(input.max_chars ? { maxChars: Number(input.max_chars) } : {}),
    });
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const view = String(input.view ?? '');
    const detail = view === 'grep' ? clip(String(input.pattern ?? ''), 30) : clip(String(input.session_id ?? ''), 10);
    return `subagent read ${view} ${detail}`;
  }
}

export class SubagentWaitTool extends MicaTool {
  constructor(private readonly registry: SubagentRegistry) {
    super(
      'subagent_wait',
      '等子会话满足一个条件，然后返回它的状态。默认等「这一轮跑完」。' +
        '这是阻塞等待（可以与同一条消息里的其它工具并行），不要在它后面再补 sleep。' +
        '并行开了几个就传 session_ids（默认等全部满足；any: true 表示任意一个满足就返回）。' +
        '超时不会白等：它会转成后台提醒，条件成立时你下一轮会自动收到，不必再查。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: '会话 id 或唯一前缀。' },
          session_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '一次等多个：默认等全部满足，配 any: true 表示任意一个满足就返回。',
          },
          any: { type: 'boolean', description: 'true 时任意一个满足就返回（配合 session_ids）。' },
          until: {
            type: 'string',
            enum: ['idle', 'text', 'turn'],
            description:
              'idle = 等当前与排队消息全部结束；text = 在最近一轮完整正文匹配 pattern（已出现也算）；turn = 等至少一轮在调用后结束，包含当前正在运行的轮次。默认 idle。',
          },
          pattern: { type: 'string', description: 'until=text 时的正则（区分大小写），在最近一轮正文里匹配。' },
          timeout_ms: { type: 'number', description: `等待上限，默认 ${DEFAULT_WAIT_TIMEOUT_MS}ms，最大 900000。` },
        },
      },
      { overlappable: true },
    );
  }

  async execute(
    input: {
      session_id?: string;
      session_ids?: string[];
      any?: boolean;
      until?: string;
      pattern?: string;
      timeout_ms?: number;
    },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    if (input.until !== undefined && input.until !== 'idle' && input.until !== 'text' && input.until !== 'turn') {
      return 'until 必须为 idle、text 或 turn。';
    }
    if (input.timeout_ms !== undefined && (!Number.isFinite(input.timeout_ms) || input.timeout_ms <= 0)) {
      return 'timeout_ms 必须为正数。';
    }
    const ids = [...new Set([...(input.session_ids ?? []), ...(input.session_id ? [input.session_id] : [])])];
    if (!ids.length) return '看不出要等哪一条：给 session_id，或者给 session_ids 数组。';
    const entries = ids.map((id) => this.registry.get(String(id)));
    const missing = ids.filter((_, index) => !entries[index]);
    if (missing.length) return `找不到子会话：${missing.join('、')}`;
    const targets = entries.map((entry) => entry!);
    const any = input.any === true;
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

    // 基线在等待开始时取一次：`turn` 的语义是「调用之后至少一轮结束」。
    const baselines = new Map(targets.map((entry) => [entry.id, waitBaseline(entry.process.transcript)]));
    const deadline = Date.now() + parseTimeout(input.timeout_ms);
    const describe = (): string =>
      targets
        .map((entry) => {
          const transcript = entry.process.transcript;
          const verdict = waitSatisfied(transcript, until, pattern, baselines.get(entry.id)!);
          return `· ${entry.id}「${clip(entry.title, 30)}」：${verdict.done ? '✓ ' + (verdict.detail ?? '成立') : '还在等'}`;
        })
        .join('\n');
    const satisfiedCount = (): number =>
      targets.filter((entry) => {
        if (entry.process.closed) return true;
        return waitSatisfied(entry.process.transcript, until, pattern, baselines.get(entry.id)!).done;
      }).length;

    while (true) {
      if (callbacks?.signal?.aborted) {
        return `已取消等待（${targets.map((entry) => entry.id).join('、')} 仍在跑）。`;
      }
      if (targets.length === 1) {
        const entry = targets[0]!;
        if (entry.process.closed) return `子会话进程已退出。\n\n${renderSubagent(entry)}`;
        const verdict = waitSatisfied(entry.process.transcript, until, pattern, baselines.get(entry.id)!);
        if (verdict.done) {
          // 条件成立时一定要给全量投影：模型等的就是这份结果。
          return `${verdict.detail ?? '条件成立'}\n\n${renderSubagent(entry)}`;
        }
      } else {
        const satisfied = satisfiedCount();
        const done = any ? satisfied > 0 : satisfied === targets.length;
        if (done) {
          // 多个的时候给一份齐平的摘要（每个全长投影会一次吃掉几万字符）。
          const header = any
            ? '有一个子会话已经满足条件：'
            : `${targets.length} 个子会话都满足了条件：`;
          return `${header}\n${describe()}\n\n${renderCollect(targets)}\n\n需要某一个的全文时用 subagent_status <id>。`;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // 超时之后不撒手：登记成后台等待，条件成立时跟着下一轮 prompt 一起到达。
        for (const entry of targets) {
          if (entry.process.closed) continue;
          if (waitSatisfied(entry.process.transcript, until, pattern, baselines.get(entry.id)!).done) continue;
          this.registry.registerWatcher(entry, until, pattern);
        }
        const projection = targets.length === 1 && targets[0]
          ? renderSubagent(targets[0], { quietWhenUnchanged: true })
          : renderCollect(targets);
        return (
          `等待超时（${parseTimeout(input.timeout_ms)}ms）。已经登记后台提醒：条件成立时你下一轮会自动收到，` +
          `不用再查、也不要 sleep 忙等。\n\n${projection}`
        );
      }
      // 有变化就重新判断，没变化就等到下一次通知或 500ms 兜底——不忙轮询。
      await Promise.race(
        targets.map((entry) => entry.process.waitForChange(Math.min(remaining, 500), callbacks?.signal)),
      );
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const ids = Array.isArray(input.session_ids) ? input.session_ids : [];
    if (ids.length > 1) return `subagent wait ${ids.length} 个 · ${String(input.until ?? 'idle')}`;
    return `subagent wait ${clip(String(input.session_id ?? ids[0] ?? ''), 10)} · ${String(input.until ?? 'idle')}`;
  }
}

export class SubagentStopTool extends MicaTool {
  constructor(private readonly registry: SubagentRegistry) {
    super(
      'subagent_stop',
      '停子会话，两种力度：' +
        '`action: "interrupt"` 只打断当前这一轮（进程与会话都还在，之后还能 send，已经跑出来的内容保住），' +
        '跑飞了或者不需要这个结果时用它；`action: "close"` 收掉进程（会话历史留在会话列表里，可 open 接回来），' +
        '拿到结论就用它，别让一堆跑完的子会话一直挂着。' +
        '收尾可以 all: true 一次停全部，close 还能 idle: true 只停跑完的（在跑的不动）。',
      {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['interrupt', 'close'],
            description: 'interrupt = 打断当前这一轮；close = 收掉进程（历史保留）。',
          },
          session_id: { type: 'string', description: '会话 id 或唯一前缀。' },
          session_ids: { type: 'array', items: { type: 'string' }, description: '一次停多个。' },
          all: {
            type: 'boolean',
            description: 'true 时停全部：interrupt 只打还在跑的那几个，close 连空闲的一起收。',
          },
          idle: { type: 'boolean', description: '仅 close：true 时只收跑完的（这一轮结束、没有排队消息）。' },
        },
        required: ['action'],
      },
    );
  }

  async execute(input: {
    action: string;
    session_id?: string;
    session_ids?: string[];
    all?: boolean;
    idle?: boolean;
  }): Promise<string> {
    const action = String(input.action ?? '').trim();
    if (action !== 'interrupt' && action !== 'close') return 'action 必须为 interrupt 或 close。';
    const ids = [...new Set([...(input.session_ids ?? []), ...(input.session_id ? [input.session_id] : [])])].map(String);
    if (!ids.length && input.all !== true && input.idle !== true) {
      return '看不出要停哪一条：给 session_id、session_ids，或者 all: true / idle: true。';
    }
    if (action === 'close') return this.close(ids, input);
    return this.interrupt(ids, input.all === true);
  }

  private async interrupt(ids: string[], all: boolean): Promise<string> {
    const targets = all
      ? this.registry.list().filter((entry) => entry.process.transcript.busy)
      : ids.map((id) => this.registry.get(id)).filter((entry): entry is SubagentEntry => Boolean(entry));
    if (!targets.length) {
      return all ? '当前没有在跑的子会话。' : `找不到子会话：${ids.join('、') || '（没给 id）'}`;
    }
    const lines: string[] = [];
    for (const entry of targets) {
      try {
        const stopped = await entry.process.abort();
        lines.push(stopped ? `已打断 ${entry.id} 当前这一轮。` : `${entry.id} 当前没有在跑的一轮。`);
      } catch (error) {
        lines.push(`打断 ${entry.id} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return lines.join('\n');
  }

  private async close(ids: string[], input: { all?: boolean; idle?: boolean }): Promise<string> {
    const scope = input.all === true ? 'all' : input.idle === true ? 'idle' : ids;
    const closed = await this.registry.closeMany(scope);
    if (!closed.length) {
      if (input.all === true) return '当前没有子会话。';
      if (input.idle === true) return '没有空闲的子会话可收（还在跑的不动）。';
      return `找不到子会话：${ids.join('、')}`;
    }
    const missing = Array.isArray(scope) ? scope.filter((id) => !closed.includes(id)) : [];
    return [
      `已关闭：${closed.join('、')}`,
      ...(missing.length ? [`没有找到或已关闭：${missing.join('、')}`] : []),
      '会话历史仍在会话列表里，需要时可以用 `subagent_open({ session_id })` 接回来接着干。',
    ].join('\n');
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const action = String(input.action ?? 'stop');
    if (input.all === true) return `subagent ${action} all`;
    if (input.idle === true) return `subagent ${action} idle`;
    const ids = Array.isArray(input.session_ids) ? input.session_ids : [];
    return `subagent ${action} ${clip(String(input.session_id ?? ids[0] ?? ''), 10)}`;
  }
}
