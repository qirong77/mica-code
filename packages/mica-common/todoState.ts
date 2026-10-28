/**
 * 运行计划（TODO）的纯逻辑：解析归一化、清单投影、显示规则。
 *
 * 插件（TUI 面板）、desktop（对话里的计划 dock）和工具本身读同一份规则，避免
 * 「插件里改一处、桌面端漏一处」。设计取舍参考了几家 agent 的实现：
 *
 * - 宿主只渲染，不改写模型给的状态。清单不会被「turn 正常结束」伪造为完成；
 *   唯一被修正的是展示投影（turn 结束不再有「进行中」）。
 * - 约束放 schema 和工具描述，不放执行期校验。handler 只做归一化：未知字段忽略、
 *   多个 in_progress 降级、超长截断，而不是让模型整轮白跑。
 * - `activeForm` 可选（中文没有进行时变形，必填只会逼模型把同一句话写两遍），
 *   `id` 可选（缺省由内容派生）。
 */

export const TODO_TOOL_NAME = 'todo_write';

/** 单次清单的硬上限，防止模型贴进整段计划文档。 */
export const MAX_TODOS = 20;

/** 单条文案上限。超长截断而不是报错。 */
export const MAX_TODO_TEXT_LENGTH = 240;

/** 写进工具描述的建议条目数，不参与校验。 */
export const RECOMMENDED_TODO_ITEMS = 7;

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoItem = {
  /** 稳定标识：模型可显式给出，缺省由内容派生；同一份清单内唯一。 */
  id: string;
  /** 祈使句文案，例如「跑测试」。 */
  content: string;
  /** 进行时文案，仅 in_progress 时用于展示；缺省回落 content。 */
  activeForm?: string;
  status: TodoStatus;
};

/** 一次投影出来的清单。`turnId` 为空表示这条清单不属于任何 turn（例如旧会话）。 */
export type TodoSnapshot = {
  items: TodoItem[];
  turnId: string | null;
};

/** 一次 `todo_write` 调用的记录，按时间顺序排列即可投影出当前清单。 */
export type TodoWriteEntry = {
  input: unknown;
  turnId?: string | null;
};

export type TodoProgress = {
  total: number;
  completed: number;
  remaining: number;
  /** 当前进行中的那一项（展示用文案已按 activeForm 回落）。 */
  active: TodoItem | null;
};

/** 面板/dock 的投影结果：`visible` 为 false 时不要渲染任何东西。 */
export type TodoPanel = {
  items: TodoItem[];
  visible: boolean;
};

export type TodoParseResult =
  | {
      ok: true;
      items: TodoItem[];
      /**
       * 归一化时做过的修正，供工具回显给模型。空数组表示模型给的清单完全合规。
       * 这些不是错误：执行继续，模型下一轮看到说明就会自己收敛。
       */
      notes: string[];
    }
  | { ok: false; message: string };

/**
 * 归一化 `todo_write` 入参。
 *
 * 只有「整体不可解析」（不是对象、`todos` 不是数组）才返回失败：这类输入说明模型
 * 完全没按 schema 来，静默吞掉会得到一份空清单。单个条目的问题一律修正并记 note。
 */
export function parseTodoInput(input: unknown): TodoParseResult {
  if (!isRecord(input)) return { ok: false, message: 'todo_write 需要对象入参' };
  if (!Array.isArray(input.todos)) return { ok: false, message: 'todo_write 需要 todos 数组' };

  const notes: string[] = [];
  const items: TodoItem[] = [];
  const usedIds = new Map<string, number>();
  let dropped = 0;

  for (const [index, value] of input.todos.entries()) {
    if (items.length >= MAX_TODOS) {
      dropped += 1;
      continue;
    }
    if (!isRecord(value)) {
      notes.push(`todos[${index}] 不是对象，已忽略`);
      continue;
    }

    const content = normalizeText(value.content);
    if (!content) {
      notes.push(`todos[${index}] 缺少 content，已忽略`);
      continue;
    }

    const status = isTodoStatus(value.status) ? value.status : 'pending';
    if (value.status !== undefined && !isTodoStatus(value.status)) {
      notes.push(`todos[${index}].status 不合法，已按 pending 处理`);
    }

    const baseId = normalizeText(value.id) ?? content;
    items.push({
      id: uniqueId(baseId, usedIds),
      content,
      activeForm: normalizeText(value.activeForm),
      status,
    });
  }

  if (dropped > 0) notes.push(`清单超过 ${MAX_TODOS} 项，后 ${dropped} 项已忽略`);

  const demoted = demoteExtraInProgress(items);
  if (demoted > 0) notes.push(`同时只保留一项 in_progress，其余 ${demoted} 项已按 pending 处理`);

  return { ok: true, items, notes };
}

/**
 * 把多余的 `in_progress` 降级为 `pending`。
 *
 * 只保留第一个：面板一次只能强调一件事，多个「进行中」在界面上就是噪声。
 * 返回被降级的条数，调用方决定要不要在回显里说明。
 */
export function demoteExtraInProgress(items: TodoItem[]): number {
  let seen = false;
  let demoted = 0;
  for (const item of items) {
    if (item.status !== 'in_progress') continue;
    if (!seen) {
      seen = true;
      continue;
    }
    item.status = 'pending';
    demoted += 1;
  }
  return demoted;
}

/**
 * 从按时间排列的 `todo_write` 记录里投影出当前清单：最后一条能解析的就是当前状态。
 *
 * 解析不了的历史条目直接跳过，而不是让整个投影失败——面板显示上一份合法清单，
 * 比整块消失更有用。
 */
export function projectTodoSnapshot(entries: readonly TodoWriteEntry[]): TodoSnapshot {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const parsed = parseTodoInput(entries[index].input);
    if (!parsed.ok) continue;
    return { items: parsed.items, turnId: entries[index].turnId ?? null };
  }
  return { items: [], turnId: null };
}

/**
 * 面板/dock 要显示什么。
 *
 * 计划属于**一轮**，所以显示的边界也是轮次：
 *
 * - 只在该清单所属的那一轮还在跑时出现。turn 一结束就收起——「本轮正在做什么」这个
 *   问题已经没有答案，把上一轮的清单留在屏幕上会让人以为它仍是当前进度（这是残留的
 *   主要来源）。
 * - 历史里的清单不算数：`todo_write` 会留在对话历史里，从历史投影时若拿的是上一轮的
 *   记录（`turnId` 不匹配），一律当作没有清单，而不是停下来展示过时的进度。
 * - 全部完成时也照常显示（运行中的最后一步），因为它仍是本轮的进度；收起由轮次结束
 *   负责，而不是由「做完了」负责。
 *
 * `open` 与 `running` 是两件事：`open` 回答「用户此刻要不要看这个面板」
 * （`/todo show` 或本轮进行中），`running` 回答「这些条目还在被执行吗」。
 * 分开之后，空闲时手动打开面板不会把 `in_progress` 显示成还在跑的假 spinner。
 */
export function resolveTodoPanel(
  snapshot: TodoSnapshot,
  options: { running: boolean; open: boolean; turnId?: string | null; hidden?: boolean },
): TodoPanel {
  if (options.hidden || !options.open || snapshot.items.length === 0) {
    return { items: [], visible: false };
  }
  // 条目还在跑时必须确认它们属于当前这一轮；空闲查看时不追究，用户就是要看最近那份。
  //
  // `turnId` 不传表示调用方只有一个活跃清单（TUI）；传了就必须匹配，否则是上一轮的残留。
  if (options.running) {
    const belongsToTurn = options.turnId == null || (snapshot.turnId !== null && snapshot.turnId === options.turnId);
    if (!belongsToTurn) return { items: [], visible: false };
    return { items: snapshot.items, visible: true };
  }
  // 没有东西在跑：只做展示投影，数据不动。
  return {
    items: snapshot.items.map((item) => (item.status === 'in_progress' ? { ...item, status: 'pending' } : item)),
    visible: true,
  };
}

/** 计数。`active` 用于「当前在做什么」的一行摘要。 */
export function summarizeTodoProgress(items: readonly TodoItem[]): TodoProgress {
  let completed = 0;
  let active: TodoItem | null = null;
  for (const item of items) {
    if (item.status === 'completed') completed += 1;
    else if (item.status === 'in_progress' && !active) active = item;
  }
  return {
    total: items.length,
    completed,
    remaining: items.length - completed,
    active,
  };
}

/** 单条展示文案：进行中用 activeForm，其余用 content。 */
export function todoItemLabel(item: TodoItem): string {
  return item.status === 'in_progress' ? (item.activeForm ?? item.content) : item.content;
}

/**
 * 工具回显。
 *
 * 只列未完成项 + 完成计数，而不是把整份清单贴回去：清单本身已经在面板上，
 * 模型需要的是「权威的剩余项」，长对话里这段回显也是防止清单漂移的锚点。
 */
export function formatTodoSummary(items: readonly TodoItem[]): string {
  const progress = summarizeTodoProgress(items);
  if (progress.total === 0) return 'TODO 清单已清空。';
  if (progress.remaining === 0) {
    return `TODO 清单已更新：${progress.total}/${progress.total} 完成。全部结束。`;
  }

  const lines = [`TODO 清单已更新：${progress.completed}/${progress.total} 完成，剩 ${progress.remaining} 项。`];
  for (const item of items) {
    if (item.status === 'completed') continue;
    lines.push(`- [${item.status === 'in_progress' ? '>' : ' '}] ${item.content}`);
  }
  return lines.join('\n');
}

/** 归一化时得到的说明拼进回显，让模型看到自己哪里不合规。 */
export function appendTodoNotes(summary: string, notes: readonly string[]): string {
  if (notes.length === 0) return summary;
  return `${summary}\n\n注意：\n${notes.map((note) => `- ${note}`).join('\n')}`;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.length > MAX_TODO_TEXT_LENGTH ? normalized.slice(0, MAX_TODO_TEXT_LENGTH) : normalized;
}

function uniqueId(base: string, used: Map<string, number>): string {
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}#${count + 1}`;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
