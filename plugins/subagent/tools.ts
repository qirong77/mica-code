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
 * 子会话的工具：四个动词，一个主语。
 *
 * 主语是「一条被驱动的 mica 会话」（`session_id`，可只给唯一前缀），动词只有四个：
 *
 * - `subagent_drive`   给它活：新建（无 id）/ 接管已落盘会话（有 id）/ 追加一句（有 id + prompt）；
 * - `subagent_inspect` 看它：状态（一条 / 全部一行 / 收尾汇总）与内容（轮次 / 命中行 / 正文）；
 * - `subagent_wait`    等它：阻塞到条件成立，超时转后台提醒；
 * - `subagent_stop`    停它：打断这一轮，或收掉进程。
 *
 * 为什么只有四个：`send` 本来就是 `drive` 的子集（给已有 id + prompt 就是追加一句），
 * `status` / `collect` / `turns` / `grep` / `transcript` 是同一个「看」轴上的六档详细度，
 * `abort` / `close` 是同一个「停」轴的两种力度。按实现分层一格一个工具名，等于让模型每次
 * 在一排近义名字里重新挑一遍——而那些 schema 全都进每次请求的前缀。力度用参数表达，
 * 顺序与成本写在描述里。
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
 * 新建（第一句话）、接管后补一句、对在跑的会话追加，走的是同一条投递路径——排队提示与
 * 「进程已经退了」的处理必须一模一样。
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
        `先 \`subagent_drive({ session_id: "${entry.id}" })\` 接回这条会话，再带上 prompt 就接着干。`
      );
    }
    return `发送失败：${message}`;
  }
}

export class SubagentDriveTool extends MicaTool {
  constructor(private readonly registry: SubagentRegistry) {
    super(
      'subagent_drive',
      '把活交给一条 mica 会话，返回会话 id。三种用法：' +
        '**只给 prompt** = 新建一条子会话并投第一件事——适合把一段能独立完成、又不该占满当前上下文的工作交出去' +
        '（跑一组测试、查一份资料、改一个独立模块）；它出现在会话列表里（挂在当前会话下面），用户可以自己点开看。' +
        '**给 session_id + prompt** = 往这条会话里投一句话（跑着时排到下一迭代边界，空闲时开新一轮）；' +
        '它还没被驱动过就顺手接管——这也是「收掉之后接回来接着干」的写法。' +
        '**只给 session_id** = 接管一条已经落盘的会话（用户别的会话、别处收掉的子会话、重启前留下的），' +
        '历史从会话文件补进来（工具调用只有名字），不新建、不产生空壳。' +
        EXECUTE_NOTE +
        '投完先用 subagent_wait 等结果，不要立刻连续追加。',
      {
        type: 'object' as const,
        properties: {
          prompt: {
            type: 'string',
            description:
              '交给它的话：目标、边界、验证方式都要写清楚。新建时必填（就是第一件事）；给 session_id 时可省（只接管不派活）。',
          },
          session_id: { type: 'string', description: '目标会话的 id（可只给唯一前缀）。省略则新建一条；接管不到当前会话自己。' },
          title: {
            type: 'string',
            description: '便于在 subagent_inspect 里辨认的标签；新建时缺省取 prompt 第一行，接管时缺省取会话标题。',
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
    const requested = String(input.session_id ?? '').trim();
    const prompt = String(input.prompt ?? '');
    if (requested) return this.resume(requested, input, prompt, callbacks);
    if (!prompt.trim()) {
      return '要么给 prompt 新建一条子会话，要么给 session_id 接管一条已有的：两个都没给，看不出要驱动哪条。';
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
      '· `subagent_inspect` 看它现在说到哪了、调了哪些工具',
      '· 跑完用 `subagent_stop({ action: "close" })` 收掉进程（不收也会一直待着，像正常会话一样）',
      '',
      '它每一轮结束、卡住、进程退出都会记成一条动态，你下一轮开工时自动看到——不必反复轮询。',
      '注意：会话文件要等它这一轮结束才会落盘，在那之前侧栏还看不到它。',
    ].join('\n');
  }

  /** 已经有 id：接管（幂等）或直接对它说一句。 */
  private async resume(
    requested: string,
    input: { cwd?: string; title?: string },
    prompt: string,
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    // 前缀是模型最爱省的写法：先按登记表解析成完整 id，接管的落盘查找只认完整 id。
    const known = this.registry.get(requested);
    const result = await this.registry.attach({
      sessionId: known?.id ?? requested,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(callbacks?.signal ? { signal: callbacks.signal } : {}),
    });
    if (!result.ok) return result.error;
    if (prompt.trim()) return deliver(result.entry, prompt);
    return [
      `已接管会话：${result.entry.id}`,
      `标题：${result.entry.title}`,
      `目录：${result.entry.cwd}`,
      '',
      '它现在空闲，接着干的下一步：',
      '· `subagent_drive({ session_id, prompt })` 交给它下一句',
      '· `subagent_inspect({ session_id, view: "turns" })` 看它之前做到哪了（历史来自会话文件）',
    ].join('\n');
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    if (input.session_id) return `subagent drive ${clip(String(input.session_id), 10)}`;
    return `subagent drive ${clip(String(input.title ?? input.prompt ?? ''), 40)}`;
  }
}

type InspectInput = {
  session_id?: string;
  session_ids?: string[];
  full?: boolean;
  view?: string;
  limit?: number;
  pattern?: string;
  max_matches?: number;
  scope?: 'text' | 'tools' | 'all';
  last_turns?: number;
  include_user?: boolean;
  max_chars?: number;
};

export class SubagentInspectTool extends MicaTool {
  constructor(private readonly registry: SubagentRegistry) {
    super(
      'subagent_inspect',
      '看子会话，六档详细度，**按成本从低到高走，不要跳级**。不给 view 就是状态：' +
        '带 session_id 看这一条的进度（在不在跑、这一轮说到哪、调了哪些工具、上一轮结论），什么都不带就列出全部（每条一行）；' +
        '`full: true` 换成收尾视图——每条的状态、轮数、最后一轮结论、失败的工具与用量，一屏替代 wait×N + 读正文×N。' +
        '给 view 就是读内容：`turns` 轮次索引（每轮一行，先定位第几轮）→ ' +
        '`grep` 命中行（`pattern`，`scope: "tools"` 连命令输出与测试报错一起搜）→ ' +
        `\`transcript\` 正文（用户 + 助手，不含工具与思考，按字符预算截断，默认 ${DEFAULT_TRANSCRIPT_CHARS}、默认只读最近 1 轮）。` +
        '给 `session_ids` 可以一次读多条（按条分摊预算），不必一条一条来。' +
        '只读，运行中随时可看；状态投影自上次查看后没有新输出时只回一行，反复查不会把上下文撑大。',
      {
        type: 'object' as const,
        properties: {
          session_id: {
            type: 'string',
            description: '会话 id 或唯一前缀。什么都不给时看全部；带 view 时给这个或 session_ids（二者其一）。',
          },
          session_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '一次看这几条：不给 view 时是收尾视图；给 view 时按条读内容（每条分摊字符/命中预算）。',
          },
          full: {
            type: 'boolean',
            description:
              '要「全部」时就用它：不给 view 时是收尾视图（每条结论、失败工具、用量）；给了 view 时除了那一档，再附一份状态 / 收尾投影，不用猜该选哪一档。',
          },
          view: {
            type: 'string',
            enum: ['turns', 'grep', 'transcript'],
            description: '读内容：turns = 轮次索引；grep = 命中行；transcript = 正文。省略则看状态。',
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
      },
      { readOnly: true },
    );
  }

  async execute(input: InspectInput): Promise<string> {
    if (input.view !== undefined) return this.read(input);
    return this.state(input);
  }

  /** 内容视图：轮次索引 / 命中行 / 正文。 */
  private read(input: InspectInput): string {
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
    // `view` 与 `session_ids` 一起传是模型最自然的读法（「看这两条的正文」）。
    // 以前这里只认单条 session_id，于是整整一轮里同一个调用被拒了十几次，
    // 模型还以为是 id 写错了。多条就按条读、按条分摊预算。
    const requested = [
      ...new Set([
        ...(input.session_id ? [String(input.session_id)] : []),
        ...(input.session_ids ?? []).map(String),
      ]),
    ].filter(Boolean);
    if (!requested.length) {
      return `view=${view} 需要 session_id 或 session_ids：读一条给 session_id，读多条给 session_ids。`;
    }
    this.registry.sweep();
    const looked = requested.map((id) => this.registry.get(id));
    const entries = looked.filter((entry): entry is SubagentEntry => Boolean(entry));
    const missing = requested.filter((_, index) => !looked[index]);
    if (!entries.length) return `找不到子会话：${requested.join('、')}。用 subagent_inspect 列出当前有哪些。`;
    for (const entry of entries) this.registry.markRead(entry.id);

    // 多条的预算按条分摊：一次读三条不该等于把三份全文都灌进上下文。
    const count = entries.length;
    const perChars = Math.max(
      1_000,
      Math.floor((input.max_chars ? Number(input.max_chars) : DEFAULT_TRANSCRIPT_CHARS) / count),
    );
    const perMatches = Math.max(1, Math.floor((input.max_matches ? Number(input.max_matches) : 8) / count));
    const blocks = entries.map((entry) => {
      const body =
        view === 'turns'
          ? renderTurnIndex(entry, input.limit ? { limit: Number(input.limit) } : {})
          : view === 'grep'
            ? grepTranscript(entry, {
                pattern: pattern!,
                maxMatches: perMatches,
                ...(input.scope ? { scope: input.scope } : {}),
              })
            : renderTranscript(entry, {
                ...(input.last_turns ? { lastTurns: Number(input.last_turns) } : {}),
                ...(input.include_user === false ? { includeUser: false } : {}),
                maxChars: perChars,
              });
      return count === 1 ? body : `会话 ${entry.id}「${clip(entry.title, 30)}」\n${body}`;
    });
    if (missing.length) blocks.push(`没找到：${missing.join('、')}`);
    // `full: true` 与 view 同用时，除了那一档再附一份完整状态 / 收尾投影。
    // 真实链路里模型会把 full 和 view 一起填满（schema 里的字段它都会填），只按 view
    // 返回的话它拿到的仍是「几行索引」，于是同一个调用重复了七次——每一次都想看到结论。
    const state =
      input.full === true
        ? count === 1
          ? renderSubagent(entries[0]!, { full: true })
          : renderCollect(entries)
        : '';
    return state ? [state, ...blocks].join('\n\n') : blocks.join('\n\n');
  }

  /** 状态视图：一条的进度 / 全部一行 / 收尾汇总。 */
  private state(input: InspectInput): string {
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
    if (!entries.length) return '当前没有子会话。需要时用 subagent_drive 开一个。';
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
    return `${report}\n\n不再需要的用 subagent_stop({ action: "close", idle: true }) 收掉跑完的（历史与会话仍在，可 drive 接回）。`;
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const view = typeof input.view === 'string' ? input.view : '';
    if (view === 'grep') return `subagent inspect grep ${clip(String(input.pattern ?? ''), 30)}`;
    if (view) return `subagent inspect ${view} ${clip(String(input.session_id ?? ''), 10)}`;
    if (input.session_id) return `subagent inspect ${clip(String(input.session_id), 10)}`;
    return input.full === true || Array.isArray(input.session_ids) ? 'subagent inspect 收尾' : 'subagent list';
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
          return `${header}\n${describe()}\n\n${renderCollect(targets)}\n\n需要某一个的全文时用 subagent_inspect <id>。`;
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
        '`action: "interrupt"` 只打断当前这一轮（进程与会话都还在，之后还能 drive，已经跑出来的内容保住），' +
        '跑飞了或者不需要这个结果时用它；`action: "close"` 收掉进程（会话历史留在会话列表里，可 drive 接回来），' +
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
    // idle 的语义是「只收跑完的」：对打断没有意义。不挡掉的话后面会走到
    // 「找不到子会话：（没给 id）」，模型会以为 id 写错了。
    if (action === 'interrupt' && input.idle === true) {
      return 'idle 只用于 close（只收跑完的）；打断请给 session_id，或用 all: true。';
    }
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
        if (!stopped) {
          lines.push(`${entry.id} 当前没有在跑的一轮。`);
          continue;
        }
        // `turn/interrupt` 的响应只代表「请求被接受」：这一轮要等正在跑的工具被掐掉
        // 才算真的结束。不确认就回「已打断」，紧接着 inspect 又会看到「运行中」——
        // 读的人只会以为打断失败，然后再按一次。
        if (await this.settled(entry, 4_000)) {
          lines.push(`已打断 ${entry.id} 当前这一轮。`);
          continue;
        }
        const tool = entry.process.transcript.runningTool;
        lines.push(
          `打断已发出，${entry.id} 这一轮还在收尾${tool ? `（当前工具：${tool.title}）` : ''}。` +
            '要等它真正停下来用 subagent_wait，不要连着再按 interrupt。',
        );
      } catch (error) {
        lines.push(`打断 ${entry.id} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return lines.join('\n');
  }

  /** 打断之后等这一轮真的收尾（有上限）：返回是否已经停下。 */
  private async settled(entry: SubagentEntry, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!entry.process.transcript.settled) {
      if (entry.process.closed) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await entry.process.waitForChange(Math.min(remaining, 250));
    }
    return true;
  }

  /** 这一条是不是「跑完了、也没有排队消息」：close 的 idle 口径。 */
  private idleEntry(entry: SubagentEntry): boolean {
    return !entry.process.transcript.busy && entry.process.transcript.settled;
  }

  private async close(ids: string[], input: { all?: boolean; idle?: boolean }): Promise<string> {
    // 两个维度分开：`all` / 显式 id 决定「在哪一批里挑」，`idle` 只是这一批里的过滤
    // 条件。以前的写法是 `all ? 'all' : idle ? 'idle' : ids`——`idle` 会把 id 选择
    // 悄悄放大成「所有空闲会话」（真实链路里模型就是 id 与 idle 一起给的），而
    // `all + idle` 又会把还在跑的一起收掉。现在两种组合都只按交集生效。
    const idleOnly = input.idle === true;
    // 不需要过滤的两个批量口径直接交给登记表，省一次枚举。
    if (input.all === true && !idleOnly) {
      const closed = await this.registry.closeMany('all');
      return closed.length ? this.closeReport(closed, [], []) : '当前没有子会话。';
    }
    if (!input.all && !ids.length && idleOnly) {
      const closed = await this.registry.closeMany('idle');
      return closed.length ? this.closeReport(closed, [], []) : '没有空闲的子会话可收（还在跑的不动）。';
    }
    // `all` 与「什么 id 都没给、只给 idle」都是「在全部里挑」。
    const everyEntry = input.all === true || !ids.length;
    const looked = everyEntry ? null : ids.map((id) => this.registry.get(id));
    const candidates = looked ? looked.filter((entry): entry is SubagentEntry => Boolean(entry)) : this.registry.list();
    const missing = looked ? ids.filter((_, index) => !looked[index]) : [];
    const targets = idleOnly ? candidates.filter((entry) => this.idleEntry(entry)) : candidates;
    const held = candidates.filter((entry) => !targets.includes(entry)).map((entry) => entry.id);
    if (!targets.length) {
      if (everyEntry) return idleOnly ? '没有空闲的子会话可收（还在跑的不动）。' : '当前没有子会话。';
      if (idleOnly && held.length) return `还在跑，没动：${held.join('、')}（要停就 action: "interrupt"）`;
      if (missing.length) return `没关：${missing.map((id) => `${id}（没有找到或已经关了）`).join('、')}`;
      return `找不到子会话：${ids.join('、')}`;
    }
    const closed = await this.registry.closeMany(targets.map((entry) => entry.id));
    const stuck = targets.filter((entry) => !closed.includes(entry.id)).map((entry) => entry.id);
    return this.closeReport(closed, held, [
      ...missing.map((id) => `${id}（没有找到或已经关了）`),
      ...stuck.map((id) => `${id}（没能关闭）`),
    ]);
  }

  private closeReport(closed: string[], stillRunning: string[], missing: string[]): string {
    const lines: string[] = [];
    if (closed.length) lines.push(`已关闭：${closed.join('、')}`);
    if (stillRunning.length) lines.push(`还在跑，没动：${stillRunning.join('、')}（要停就 action: "interrupt"）`);
    if (missing.length) lines.push(`没有关：${missing.join('、')}`);
    if (closed.length) {
      lines.push('会话历史仍在会话列表里，需要时可以用 `subagent_drive({ session_id })` 接回来接着干。');
    }
    return lines.join('\n');
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const action = String(input.action ?? 'stop');
    if (input.all === true) return `subagent ${action} all`;
    if (input.idle === true) return `subagent ${action} idle`;
    const ids = Array.isArray(input.session_ids) ? input.session_ids : [];
    return `subagent ${action} ${clip(String(input.session_id ?? ids[0] ?? ''), 10)}`;
  }
}
