/**
 * `/btw` 的命令行形态：参数解析与结果呈现。
 *
 * 与 `mica-builtin-commands/shared/btwThread.ts` 分开：那边是「旁问是什么」（提示词、
 * 背景记录），两端（TUI 命令与桌面端抽屉）必须一致；这里是「终端里怎么读参数、答案
 * 怎么排」，只有这条命令关心。
 */

export type BtwArgs =
  | { kind: 'ask'; question: string; isContinue: boolean }
  | { kind: 'stop' }
  | { kind: 'help' };

/**
 * `/btw 问题`、`/btw -continue 追问`、`/btw -stop`、`/btw -h`。
 *
 * 子命令按**第一个词**判定（不再用前缀切片）：`-continue` 后面必须跟问题，否则按
 * 帮助处理——把「只有 -continue」当成新问题发出去，用户只会得到一句莫名其妙地回答。
 * 以 `-` 开头的普通问题（`-5 的补码是什么`）不受影响：第一个词不是已知子命令时，
 * 整段就是问题。
 */
export function parseBtwArgs(rawArgs: string): BtwArgs {
  const trimmed = rawArgs.trim();
  if (!trimmed) return { kind: 'help' };
  const space = trimmed.search(/\s/);
  const head = space < 0 ? trimmed : trimmed.slice(0, space);
  const tail = space < 0 ? '' : trimmed.slice(space).trim();
  switch (head) {
    case '-continue':
    case '--continue':
    case '-c':
      return tail ? { kind: 'ask', question: tail, isContinue: true } : { kind: 'help' };
    case '-stop':
    case '--stop':
      return { kind: 'stop' };
    case '-h':
    case '--help':
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'ask', question: trimmed, isContinue: false };
  }
}

/** 帮助与用法错误共用一段文案：终端里没有别的地方能解释这几个开关。 */
export function btwHelpText(): string {
  return [
    '用法：',
    '/btw <问题>            开一条旁问（回答不进入主对话上下文）',
    '/btw -continue <追问>  在同一个 btw 线程里追问，它记得上一轮读过什么',
    '/btw -stop             停止正在回答的旁问',
    '',
    '主流程运行中也能问；一次只回答一个问题。',
  ].join('\n');
}

/** `8.4s` / `1m12s`：与状态行同一个读法，太长的小数没有意义。 */
export function formatBtwElapsed(elapsedMs: number): string {
  const ms = Math.max(0, Number(elapsedMs) || 0);
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/** 1_200 → `1.2k`：进度行里只报个量级，精确值留在最终结果上。 */
function shortCount(value: number): string {
  const count = Math.max(0, Math.round(Number(value) || 0));
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

function oneLine(text: string, max: number): string {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export type BtwProgress = {
  question: string;
  /** 最近一次工具调用的名字（工具行退出后传空）。 */
  tool?: string;
  /** 已经流出的正文长度（字符）。 */
  answerChars?: number;
  elapsedMs: number;
};

/**
 * 运行中固定在输入框上方的那一块：问题 + 正在做什么。
 *
 * 终端里没有流式正文的位置，但「在调工具」和「已经出字了」是两件不同的事——长时间
 * 只写「正在思考…」会让用户以为卡住了，而这正是旁问最常被用到的场景（主流程在跑，
 * 顺手问一句长的）。
 */
export function formatBtwProgress(progress: BtwProgress): string {
  const head = `> ${oneLine(progress.question, 80)}`;
  const elapsed = formatBtwElapsed(progress.elapsedMs);
  const tool = progress.tool?.trim();
  const answerChars = Math.max(0, Number(progress.answerChars) || 0);
  const doing = tool
    ? `正在调用 ${tool}…`
    : answerChars > 0
      ? `正在回答… ${shortCount(answerChars)} 字`
      : '正在思考…';
  return `${head}\n${doing} · ${elapsed}（/btw -stop 停止）`;
}

export type BtwNoticeStats = {
  /** `-continue` 找不到线程时，答案是当成新问题得到的。 */
  isFallback?: boolean;
  elapsedMs?: number;
  /** 这一问实际发出的模型请求数（多轮工具迭代时大于 1）。 */
  requests?: number;
};

/**
 * 一条 btw 结果：原问题（引用块）+ 可选的「没有前文」说明 + 回答 + 统计与追问提示。
 *
 * `isFallback` 只在 `-continue` 找不到线程时给出——那时答案是当成新问题得到的，用户
 * 需要知道这一点，否则会以为模型忘掉了前文。
 */
export function formatBtwNotice(
  question: string,
  answer: string,
  options: BtwNoticeStats = {},
): string {
  const fallback = options.isFallback ? ['', '_没有可延续的 btw 对话，已作为一条新问题处理_'] : [];
  const stats: string[] = [];
  if (Number(options.elapsedMs) > 0) stats.push(formatBtwElapsed(Number(options.elapsedMs)));
  if (Number(options.requests) > 0) stats.push(`${Number(options.requests)} 次请求`);
  stats.push('`/btw -continue` 继续追问');
  return [`> ${question}`, ...fallback, '', answer, '', `── ${stats.join(' · ')} ──`].join('\n');
}

/**
 * 用户按了 `/btw -stop`：已经流出的那半段就是这一问唯一的记录，不能丢。
 *
 * 与报错分开：停止是用户的动作，不是失败。
 */
export function formatBtwStopped(question: string, partialAnswer = ''): string {
  const partial = partialAnswer.trim();
  const body = partial ? ['', '已输出的部分：', '', partial] : [];
  return [`> ${question}`, '', '_已停止（可用 `/btw -continue` 接着问）_', ...body].join('\n');
}
